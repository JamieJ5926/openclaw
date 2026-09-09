// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import "../agents/auth-profiles/oauth-external-auth-passthrough.test-support.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { PROXY_ENV_KEYS } from "./net/proxy-env.js";

const hooks = vi.hoisted(() => ({
  auth: undefined as (() => Promise<void>) | undefined,
  transport: undefined as (() => Promise<void>) | undefined,
  usage: vi.fn(),
}));
vi.mock("../plugins/provider-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-runtime.js")>();
  return {
    ...actual,
    listProviderUsagePluginDescriptors: () =>
      ["anthropic", "openrouter"].map((provider) => ({
        provider,
        displayName: provider,
        supportsAccountUsage: true,
      })),
    resolveProviderUsageAuthWithPlugin: async ({
      context,
    }: Parameters<typeof actual.resolveProviderUsageAuthWithPlugin>[0]) => {
      await hooks.auth?.();
      if (context.provider === "openrouter") {
        const token = context.resolveApiKeyFromConfigAndStore();
        return token ? { token } : undefined;
      }
      return context.resolveOAuthToken();
    },
    resolveProviderOAuthRefreshCapabilityWithPlugin: async () => ({ status: "available" }),
    resolveProviderOAuthCredentialWithPlugin: async (
      params: Parameters<typeof actual.resolveProviderOAuthCredentialWithPlugin>[0],
    ) => ({
      status: "available",
      credential: {
        ...params.credential,
        access: "refreshed-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 3_600_000,
      },
      apiKey: "refreshed-access",
    }),
    formatProviderAuthProfileApiKeyWithPlugin: async () => undefined,
    resolveProviderUsageSnapshotWithPlugin: async ({
      context,
    }: Parameters<typeof actual.resolveProviderUsageSnapshotWithPlugin>[0]) => {
      hooks.usage();
      await hooks.transport?.();
      await context.fetchFn("https://usage.example.invalid", {
        headers: { Authorization: `Bearer ${context.token}` },
      });
      return {
        provider: context.provider,
        displayName: context.provider,
        usageScope: "account",
        windows: [{ label: "5h", usedPercent: 25 }],
      };
    },
  };
});

it.each(["refresh", "config", "replaced", "removed", "bookkeeping"] as const)(
  "keeps account usage bound to its live owner (%s)",
  async (change) => {
    // Catalog discovery stays synthetic; credential persistence and publication are real.
    vi.doUnmock("../agents/auth-profiles/runtime-snapshots.js");
    vi.doUnmock("../agents/auth-profiles/runtime-materializations.js");
    vi.doMock("../agents/auth-profiles/external-cli-sync.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../agents/auth-profiles/external-cli-sync.js")>()),
      listExternalCliSyncProviderIds: () => [],
      resolveExternalCliAuthProfiles: () => [],
    }));
    const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    const { createExpiredOauthStore } = await import("../agents/auth-profiles/oauth-test-utils.js");
    const { loadPersistedAuthProfileStore } = await import("../agents/auth-profiles/persisted.js");
    const {
      clearRuntimeAuthProfileStoreSnapshots,
      listOwnedRuntimeAuthProfileStoreSnapshots,
      replaceRuntimeAuthProfileStoreSnapshots,
      replaceOwnedRuntimeAuthProfileStoreSnapshots,
      getRuntimeAuthProfileStoreCredentialsRevision,
    } = await import("../agents/auth-profiles/runtime-snapshots.js");
    const { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } =
      await import("../agents/auth-profiles/store-runtime.js");
    const { clearModelAuthStatusUsageCache } =
      await import("../gateway/server-methods/models-auth-status-usage-cache.js");
    const { refreshPreparedModelRuntimeSnapshots, markPreparedModelRuntimeSnapshotsStale } =
      await import("../agents/prepared-model-runtime.js");
    const { readPreparedGatewayModelCatalogOwnerSnapshot } =
      await import("../gateway/server-model-catalog.js");
    const { registerGatewayModelCatalogPrivateAccess } =
      await import("../gateway/server-model-catalog-auth.js");
    const { createDirectChatContext } =
      await import("../gateway/server-chat.agent-events.test-helpers.js");
    const { modelsAuthUsageHandlers } =
      await import("../gateway/server-methods/models-auth-usage.js");
    const state = await createOpenClawTestState({ label: "usage-owner" });
    const release = createDeferred();
    const started = createDeferred();
    const transport = vi.fn<typeof fetch>(async () => new Response("{}"));
    let failed = true;
    try {
      await resetPreparedModelRuntimeHarness(state);
      clearModelAuthStatusUsageCache();
      hooks.usage.mockClear();
      hooks.auth =
        change === "config"
          ? async () => {
              started.resolve();
              await release.promise;
            }
          : undefined;
      hooks.transport =
        change !== "config" && change !== "refresh"
          ? async () => {
              started.resolve();
              await release.promise;
            }
          : undefined;
      for (const key of PROXY_ENV_KEYS) {
        vi.stubEnv(key, "");
      }
      vi.stubGlobal("fetch", transport);
      const agentDir = state.agentDir("default");
      const provider = change === "refresh" || change === "config" ? "anthropic" : "openrouter";
      const profileId = `${provider}:account`;
      const config = {};
      const store =
        provider === "anthropic"
          ? createExpiredOauthStore({ profileId, provider })
          : {
              version: 1,
              profiles: {
                [profileId]: { type: "api_key" as const, provider, key: "synthetic-original" },
              },
            };
      if (change === "config") {
        store.profiles[profileId] = { type: "token", provider, token: "synthetic-original" };
      }
      if (change === "refresh") {
        store.profiles["anthropic:other"] = {
          type: "token",
          provider,
          token: "synthetic-other-account",
        };
        store.order = { anthropic: ["anthropic:other", profileId] };
      }
      saveAuthProfileStore(store, agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
      const runtime = getPreparedModelRuntimeMocks();
      runtime.configuredAgentIds = ["default"];
      runtime.configuredWorkspaces.set("default", state.workspaceDir);
      runtime.discoverAuthStorage.mockImplementation(() => {
        runtime.preparedAuthStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
        return runtime.authStorage;
      });
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const readPrepared = () =>
        readPreparedGatewayModelCatalogOwnerSnapshot({
          agentId: "default",
          getConfig: () => config,
        });
      const prepared = expectDefined(await readPrepared(), "published account owner");
      const loader = async () => prepared;
      registerGatewayModelCatalogPrivateAccess(loader, { readPrepared, loadDeferred: loader });
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: loader,
      });
      const read = async () => {
        const respond = vi.fn();
        const params = { agentId: "default", profileId };
        await expectDefined(
          modelsAuthUsageHandlers["models.authUsage"],
          "usage handler",
        )({
          req: { type: "req", id: "usage", method: "models.authUsage", params },
          params,
          context,
          client: null,
          respond,
          isWebchatConnect: () => false,
        });
        return respond.mock.calls[0];
      };
      const pending = read();
      if (change !== "refresh") {
        await started.promise;
        if (change === "config") {
          const revision = getRuntimeAuthProfileStoreCredentialsRevision();
          markPreparedModelRuntimeSnapshotsStale("config reload");
          expect(prepared.isCurrent()).toBe(false);
          expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(revision);
        } else {
          const snapshots = listOwnedRuntimeAuthProfileStoreSnapshots();
          expect(snapshots.some((entry) => entry.store.profiles[profileId])).toBe(true);
          for (const entry of snapshots) {
            if (!entry.store.profiles[profileId]) {
              continue;
            }
            if (change === "removed") {
              delete entry.store.profiles[profileId];
            }
            if (change === "replaced") {
              entry.store.profiles[profileId] = {
                type: "api_key",
                provider,
                key: "synthetic-replacement",
              };
            }
            entry.store.usageStats = { [profileId]: { lastUsed: Date.now() } };
          }
          replaceOwnedRuntimeAuthProfileStoreSnapshots(snapshots);
        }
        release.resolve();
      }
      const result = await pending;
      const allowed = change === "refresh" || change === "bookkeeping";
      expect(transport).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) {
        expect(result).toEqual([
          true,
          expect.objectContaining({
            providers: [
              {
                provider,
                displayName: provider,
                usageScope: "account",
                windows: [{ label: "5h", usedPercent: 25 }],
              },
            ],
          }),
          undefined,
        ]);
        expect(transport.mock.calls[0]?.[1]?.headers).toEqual({
          Authorization: `Bearer ${change === "refresh" ? "refreshed-access" : "synthetic-original"}`,
        });
        if (change === "refresh") {
          expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toMatchObject({
            access: "refreshed-access",
            refresh: "rotated-refresh",
          });
          expect(await read()).toEqual(result);
          expect(transport).toHaveBeenCalledOnce();
        }
      } else {
        expect(result).toEqual([
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        ]);
        if (change === "config") {
          expect(hooks.usage).not.toHaveBeenCalled();
        }
      }
      failed = false;
    } finally {
      release.resolve();
      clearModelAuthStatusUsageCache();
      clearRuntimeAuthProfileStoreSnapshots();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await cleanupPreparedModelRuntimeHarness(state, failed);
    }
  },
);
