// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import { isDeepStrictEqual } from "node:util";
import type { AuthProfileCredential, AuthProfileStore } from "../../agents/auth-profiles.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../../agents/auth-profiles/runtime-snapshots.js";
import { fingerprintAuthProfileCredential } from "../../agents/execution-auth-binding.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { PROVIDER_USAGE_TIMEOUT_MS } from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { formatForLog } from "../ws-log.js";
import {
  clearProviderUsageRuntimeSnapshot,
  getProviderUsageRuntimeSnapshot,
} from "./provider-usage-runtime.js";

const log = createSubsystemLogger("provider-usage-cache");
const USAGE_CACHE_TTL_MS = 60_000;

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  | "windows"
  | "summary"
  | "plan"
  | "billing"
  | "costHistory"
  | "accountEmail"
  | "error"
  | "usageScope"
> & { providerId: UsageProviderId; refreshedAt: number };

type ProviderUsageCacheEntry = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  refreshedAt: number;
  summary: UsageSummary;
  isCurrent?: () => boolean;
  usageByProvider: Map<string, ProviderUsageStatus>;
};

type ProviderUsageRefresh = {
  ownerToken: object;
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  promise: Promise<UsageSummary>;
};

const usageCacheByAgentId = new Map<string, ProviderUsageCacheEntry>();
const usageRefreshByAgentId = new Map<string, ProviderUsageRefresh>();
let cacheGeneration = 0;

export function clearModelAuthStatusUsageCache(): void {
  cacheGeneration += 1;
  usageCacheByAgentId.clear();
  usageRefreshByAgentId.clear();
  clearProviderUsageRuntimeSnapshot();
}

function scopeProviderUsageCredentialKey(
  credentialKey: string,
  providerIds: readonly UsageProviderId[],
): string {
  // Scope prepared credential evidence to this fetch set so unrelated provider
  // credentials do not invalidate its snapshot.
  // SAFETY: the provider-usage runtime always serializes this shape.
  const parsed = JSON.parse(credentialKey) as {
    direct: Array<[string, string | null]>;
    [key: string]: unknown;
  };
  const providers = new Set(providerIds);
  return JSON.stringify({
    ...parsed,
    direct: parsed.direct.filter(
      ([provider, fingerprint]) => providers.has(provider) && fingerprint !== null,
    ),
  });
}

function mapProviderUsage(usage: Awaited<ReturnType<typeof loadProviderUsageSummary>>) {
  const usageByProvider = new Map<string, ProviderUsageStatus>();
  for (const snap of usage.providers) {
    usageByProvider.set(snap.provider, {
      providerId: snap.provider,
      refreshedAt: usage.updatedAt,
      windows: snap.windows,
      ...(snap.usageScope ? { usageScope: snap.usageScope } : {}),
      ...(snap.summary ? { summary: snap.summary } : {}),
      ...(snap.plan ? { plan: snap.plan } : {}),
      ...(snap.billing?.length ? { billing: snap.billing } : {}),
      ...(snap.costHistory ? { costHistory: snap.costHistory } : {}),
      ...(snap.accountEmail ? { accountEmail: snap.accountEmail } : {}),
      ...(snap.error ? { error: snap.error } : {}),
    });
  }
  return usageByProvider;
}

function isTransientUsageTimeout(error: string | undefined): boolean {
  return error === "Timeout" || error === "Refresh queue timeout";
}

function retainLastGoodOnTimeout(
  summary: UsageSummary,
  lastGood: UsageSummary | undefined,
): UsageSummary {
  if (!lastGood) {
    return summary;
  }
  const lastGoodByProvider = new Map(
    lastGood.providers
      .filter((provider) => provider.error === undefined)
      .map((provider) => [provider.provider, provider]),
  );
  const retainedLastGood = summary.providers.some(
    (provider) =>
      isTransientUsageTimeout(provider.error) && lastGoodByProvider.has(provider.provider),
  );
  return {
    ...summary,
    updatedAt: retainedLastGood ? lastGood.updatedAt : summary.updatedAt,
    providers: summary.providers.map((provider) =>
      isTransientUsageTimeout(provider.error)
        ? (lastGoodByProvider.get(provider.provider) ?? provider)
        : provider,
    ),
  };
}

function scheduleProviderUsageRefresh(params: {
  cacheOwnerKey: string;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  authProfile?: { provider: UsageProviderId; profileId: string };
  configRef: OpenClawConfig;
  credentialKey: string;
  providerIds: UsageProviderId[];
  providerKey: string;
  lastGood?: UsageSummary;
  isCurrent?: () => boolean;
}): Promise<UsageSummary> {
  const active = usageRefreshByAgentId.get(params.cacheOwnerKey);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerKey === params.providerKey
  ) {
    return active.promise;
  }
  const publishGeneration = cacheGeneration;
  const ownerToken = {};
  let credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  let isOwnerCurrent = params.isCurrent;
  const isCacheCurrent = () =>
    publishGeneration === cacheGeneration &&
    usageRefreshByAgentId.get(params.cacheOwnerKey)?.ownerToken === ownerToken;
  let credential = params.authProfile
    ? params.authStore?.profiles[params.authProfile.profileId]
    : undefined;
  let readOwner: (() => PreparedModelRuntimeSnapshot | undefined) | undefined;
  const rebindOwner = (owner: PreparedModelRuntimeSnapshot | undefined) => {
    if (
      !owner?.isCurrent() ||
      owner.config !== params.configRef ||
      !params.authProfile ||
      !credential ||
      // A reference alone cannot prove that its externally resolved secret is unchanged.
      (credential.type === "api_key" &&
        (credential.keyRef ||
          coerceSecretRef(credential.key, params.configRef.secrets?.defaults))) ||
      (credential.type === "token" &&
        (credential.tokenRef ||
          coerceSecretRef(credential.token, params.configRef.secrets?.defaults))) ||
      !isDeepStrictEqual(
        getPreparedModelRuntimeAuthStore(owner)?.profiles[params.authProfile.profileId],
        credential,
      )
    ) {
      return false;
    }
    isOwnerCurrent = owner.isCurrent;
    credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
    return true;
  };
  const isAuthCurrent = () => {
    if (credentialsRevision === getRuntimeAuthProfileStoreCredentialsRevision()) {
      return isOwnerCurrent?.() !== false;
    }
    // Sibling OAuth settlement can retire the generation without changing this account.
    // Every transport, publication, and cached read must use the current published owner.
    return rebindOwner(readOwner?.());
  };
  const isCurrent = () => isCacheCurrent() && (!params.authProfile || isAuthCurrent());
  const load = async () => {
    const runtime = params.authProfile
      ? await import("../../agents/prepared-model-runtime.js")
      : undefined;
    const ownerInput = {
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      config: params.configRef,
    };
    readOwner = runtime ? () => runtime.getPreparedModelRuntimeSnapshot(ownerInput) : undefined;
    return loadProviderUsageSummary({
      providers: params.providerIds,
      ...(params.authProfile ? { authProfile: params.authProfile } : {}),
      ...(params.authProfile
        ? {
            isAuthProfileCurrent: isCurrent,
            onAuthProfileResolved: async (resolvedCredential: AuthProfileCredential) => {
              credential = resolvedCredential;
              if (credentialsRevision === getRuntimeAuthProfileStoreCredentialsRevision()) {
                return;
              }
              if (!isCacheCurrent() || !params.authProfile || !runtime) {
                return;
              }
              // Own OAuth settlement must finish publication before accepting its new credential.
              const owner = await runtime.prepareModelRuntimeSnapshot(ownerInput);
              if (!isCacheCurrent() || !rebindOwner(owner)) {
                return;
              }
              const profileId = params.authProfile.profileId;
              params.credentialKey =
                fingerprintAuthProfileCredential({ profileId, credential: resolvedCredential }) ??
                params.credentialKey;
              const refresh = usageRefreshByAgentId.get(params.cacheOwnerKey);
              if (refresh) {
                refresh.credentialKey = params.credentialKey;
              }
            },
          }
        : {}),
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authStore: params.authStore,
      config: params.configRef,
      timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
    });
  };
  // Track publication and finalization after the stale-while-revalidate reply.
  const promise = trackAsyncWork(() =>
    load()
      .then((freshUsage) => {
        const usage = retainLastGoodOnTimeout(freshUsage, params.lastGood);
        if (isCurrent()) {
          usageCacheByAgentId.set(params.cacheOwnerKey, {
            agentDir: params.agentDir,
            configRef: params.configRef,
            credentialKey: params.credentialKey,
            providerKey: params.providerKey,
            refreshedAt: Date.now(),
            summary: usage,
            ...(params.authProfile ? { isCurrent: isAuthCurrent } : {}),
            usageByProvider: mapProviderUsage(usage),
          });
        }
        return usage;
      })
      .catch((err: unknown) => {
        log.debug(
          `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
        );
        throw err;
      })
      .finally(() => {
        if (usageRefreshByAgentId.get(params.cacheOwnerKey)?.ownerToken === ownerToken) {
          usageRefreshByAgentId.delete(params.cacheOwnerKey);
        }
      }),
  );
  const refresh: ProviderUsageRefresh = {
    ownerToken,
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
    promise,
  };
  usageRefreshByAgentId.set(params.cacheOwnerKey, refresh);
  return promise;
}

type ProviderUsageCacheParams = {
  agentId: string;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  authProfile?: { provider: UsageProviderId; profileId: string };
  cacheOwnerKey?: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  coldRead?: "refresh-marker";
  forceRefresh?: boolean;
  providerIds: UsageProviderId[];
  now: number;
};

function resolveProviderUsageCacheRead(params: ProviderUsageCacheParams) {
  const cacheOwnerKey = params.cacheOwnerKey ?? params.agentId;
  const providerIds = params.providerIds.toSorted();
  const providerKey = providerIds.join("\0");
  const credentialKey = params.authProfile
    ? params.credentialKey
    : scopeProviderUsageCredentialKey(params.credentialKey, providerIds);
  const cached = usageCacheByAgentId.get(cacheOwnerKey);
  const matching =
    cached?.agentDir === params.agentDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === credentialKey &&
    cached.providerKey === providerKey &&
    cached.isCurrent?.() !== false
      ? cached
      : undefined;
  const needsRefresh =
    params.forceRefresh === true ||
    !matching ||
    params.now - matching.refreshedAt >= USAGE_CACHE_TTL_MS;
  return { cacheOwnerKey, credentialKey, matching, needsRefresh, providerIds, providerKey };
}

export function readProviderUsageStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Map<string, ProviderUsageStatus> {
  const cacheOwnerKey = params.cacheOwnerKey ?? params.agentId;
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(cacheOwnerKey);
    return new Map();
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (needsRefresh) {
    // Never couple the RPC deadline to provider HTTP. A cold call returns auth
    // without usage; stale calls return the last snapshot while one refresh runs.
    void scheduleProviderUsageRefresh({
      cacheOwnerKey,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authStore: params.authStore,
      authProfile: params.authProfile,
      configRef: params.configRef,
      credentialKey,
      providerIds,
      providerKey,
      lastGood: matching?.summary,
    }).catch(() => {});
  }
  return matching?.usageByProvider ?? new Map();
}

export async function loadProfileUsage(params: {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  configRef: OpenClawConfig;
  profileCredentialKeys: ReadonlyMap<string, string>;
  forceRefresh?: boolean;
  profileId: string;
  providerId: UsageProviderId;
  now: number;
  isCurrent?: () => boolean;
}): Promise<UsageSummary> {
  if (params.isCurrent?.() === false) {
    throw new Error("Account credentials changed while loading usage. Refresh the account.");
  }
  const ownerPrefix = `${params.agentId}\0profile\0`;
  // A read of any account revokes work for removed or replaced credentials,
  // including accounts whose rows are no longer displayed.
  for (const entries of [usageCacheByAgentId, usageRefreshByAgentId]) {
    for (const [ownerKey, entry] of entries) {
      if (
        ownerKey.startsWith(ownerPrefix) &&
        (entry.agentDir !== params.agentDir ||
          entry.configRef !== params.configRef ||
          entry.credentialKey !==
            params.profileCredentialKeys.get(ownerKey.slice(ownerPrefix.length)))
      ) {
        entries.delete(ownerKey);
      }
    }
  }
  const cacheParams = {
    ...params,
    authProfile: { provider: params.providerId, profileId: params.profileId },
    cacheOwnerKey: `${ownerPrefix}${params.profileId}`,
    credentialKey: params.profileCredentialKeys.get(params.profileId) ?? "",
    providerIds: [params.providerId],
  };
  const read = resolveProviderUsageCacheRead(cacheParams);
  if (read.matching && !read.needsRefresh) {
    return read.matching.summary;
  }
  const generation = cacheGeneration;
  const summary = await scheduleProviderUsageRefresh({
    ...cacheParams,
    credentialKey: read.credentialKey,
    providerKey: read.providerKey,
    lastGood: read.matching?.summary,
  });
  // Publication and delivery both require the same live owner after provider I/O.
  if (
    generation !== cacheGeneration ||
    usageCacheByAgentId.get(cacheParams.cacheOwnerKey)?.isCurrent?.() === false ||
    usageCacheByAgentId.get(cacheParams.cacheOwnerKey)?.summary !== summary
  ) {
    throw new Error("Account credentials changed while loading usage. Refresh the account.");
  }
  return summary;
}

/** Shares the models.authStatus cache contract with the unscoped usage.status RPC. */
export async function loadUsageStatusStaleWhileRevalidate(options: {
  config: OpenClawConfig;
  coldRead?: "refresh-marker";
  now?: number;
}): Promise<UsageSummary> {
  const snapshot = getProviderUsageRuntimeSnapshot({ config: options.config });
  const params: ProviderUsageCacheParams = {
    agentId: snapshot.agentId,
    agentDir: snapshot.agentDir,
    authStore: snapshot.store,
    configRef: snapshot.configRef,
    credentialKey: snapshot.credentialKey,
    providerIds: snapshot.providerIds,
    coldRead: options.coldRead,
    now: options.now ?? Date.now(),
  };
  const cacheOwnerKey = params.agentId;
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(cacheOwnerKey);
    return { updatedAt: params.now, providers: [] };
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (matching && !needsRefresh) {
    return matching.summary;
  }
  const refresh = scheduleProviderUsageRefresh({
    cacheOwnerKey,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
    authProfile: params.authProfile,
    configRef: params.configRef,
    credentialKey,
    providerIds,
    providerKey,
    lastGood: matching?.summary,
  });
  if (matching) {
    void refresh.catch(() => {});
    return matching.summary;
  }
  if (params.coldRead !== "refresh-marker") {
    return await refresh;
  }
  void refresh.catch(() => {});
  return { updatedAt: params.now, providers: [], refreshing: true };
}
