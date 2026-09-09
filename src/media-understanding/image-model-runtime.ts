// Resolves image-capable model metadata and credential-bound runtime auth.
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import { isMinimaxVlmModel } from "../agents/minimax-vlm.js";
import {
  applySecretRefHeaderSentinels,
  getApiKeyForModelCore,
  requireApiKey,
  resolveApiKeyForProviderCore,
} from "../agents/model-auth.js";
import { normalizeModelRef, type ModelRef } from "../agents/model-selection.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import { retainPreparedModelRuntimeSnapshotResources } from "../agents/prepared-model-runtime.resources.js";
import { resolveProviderModelMaterializationAuthMode } from "../agents/provider-model-route-auth.js";
import {
  applyPreparedRuntimeAuthToModel,
  getModelProviderRequestTransport,
  type ModelProviderRequestTransportOverrides,
} from "../agents/provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "../agents/provider-runtime-auth-protection.js";
import { providerUsesCredentialScopedModelMetadata } from "../agents/runtime-plan/credential-scoped-model.js";
import { getModelRegistryRuntime } from "../agents/sessions/model-registry-runtime.js";
import { isSecretRef } from "../config/types.secrets.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import {
  attachModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ImageDescriptionRequest } from "./types.js";

type ImageRuntimeParams = {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  signal?: AbortSignal;
  authStore?: ImageDescriptionRequest["authStore"];
  agentId?: string;
  workspaceDir?: string;
  preparedModelRuntime?: ImageDescriptionRequest["preparedModelRuntime"];
};

type PreparedImageRuntime = { runtimeValue: string } & (
  | {
      kind: "model";
      model: Model;
      cfg: ImageRuntimeParams["cfg"];
      agentDir: string;
      workspaceDir?: string;
    }
  | {
      kind: "minimax";
      provider: string;
      modelId: string;
      modelBaseUrl?: string;
      allowPrivateNetwork?: boolean;
      request?: ModelProviderRequestTransportOverrides;
    }
);

type ImageRuntimeResources = {
  release: () => void;
  assertResourcesOpen?: () => void;
};

function bindResolvedImageRuntime(
  params: ImageRuntimeParams,
  runtimeValue: string,
  model: Model,
): PreparedImageRuntime {
  return isMinimaxVlmModel(model.provider, model.id)
    ? {
        kind: "minimax",
        runtimeValue,
        provider: model.provider,
        modelId: model.id,
        modelBaseUrl: model.baseUrl,
        request: getModelProviderRequestTransport(model),
      }
    : {
        kind: "model",
        runtimeValue,
        model,
        cfg: params.cfg,
        agentDir: params.agentDir,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      };
}

function isUnknownModelError(err: unknown): boolean {
  return err instanceof Error && /^Unknown model:/i.test(err.message);
}

function resolveConfiguredProviderBaseUrl(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string | undefined {
  const direct = cfg.models?.providers?.[provider];
  if (typeof direct?.baseUrl === "string" && direct.baseUrl.trim()) {
    return direct.baseUrl.trim();
  }
  const normalizedProvider = normalizeMediaProviderId(provider);
  const normalized = cfg.models?.providers?.[normalizedProvider];
  if (typeof normalized?.baseUrl === "string" && normalized.baseUrl.trim()) {
    if (isMinimaxCnAlias(provider) && !isMinimaxCnBaseUrl(normalized.baseUrl)) {
      return undefined;
    }
    return normalized.baseUrl.trim();
  }
  return undefined;
}

function resolveConfiguredProviderAllowPrivateNetwork(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): boolean | undefined {
  const direct = cfg.models?.providers?.[provider]?.request?.allowPrivateNetwork;
  if (typeof direct === "boolean") {
    return direct;
  }
  const normalizedProvider = normalizeMediaProviderId(provider);
  const normalized = cfg.models?.providers?.[normalizedProvider]?.request?.allowPrivateNetwork;
  if (typeof normalized === "boolean") {
    return normalized;
  }
  return undefined;
}

function isMinimaxCnAlias(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "minimax-cn" || normalized === "minimax-portal-cn";
}

function isMinimaxCnBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase() === "api.minimaxi.com";
  } catch {
    return false;
  }
}

function hasConfiguredProviderApiKey(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): boolean {
  const apiKey = cfg.models?.providers?.[provider]?.apiKey;
  return (typeof apiKey === "string" && apiKey.trim().length > 0) || isSecretRef(apiKey);
}

function resolveMinimaxVlmAuthProvider(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string {
  if (!isMinimaxCnAlias(provider) || hasConfiguredProviderApiKey(cfg, provider)) {
    return provider;
  }
  return normalizeMediaProviderId(provider);
}

async function resolveMinimaxVlmFallbackRuntime(
  params: ImageRuntimeParams,
): Promise<PreparedImageRuntime> {
  const authProvider = resolveMinimaxVlmAuthProvider(params.cfg, params.provider);
  const auth = await resolveApiKeyForProviderCore({
    provider: authProvider,
    cfg: params.cfg,
    secretSentinels: true,
    store: params.authStore,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return {
    kind: "minimax",
    provider: params.provider,
    modelId: params.model,
    runtimeValue: requireApiKey(auth, authProvider),
    allowPrivateNetwork: resolveConfiguredProviderAllowPrivateNetwork(params.cfg, params.provider),
    modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider),
  };
}

function formatModelInputCapabilities(input: Model["input"] | undefined): string {
  return input && input.length > 0 ? input.join(", ") : "none";
}

function requireImageCapableModel(params: {
  model: Model | undefined;
  resolvedProvider: string;
  resolvedModel: string;
  requestedProvider: string;
  requestedModel: string;
}): Model {
  if (!params.model) {
    throw new Error(`Unknown model: ${params.resolvedProvider}/${params.resolvedModel}`);
  }
  if (params.model.input?.includes("image")) {
    return params.model;
  }
  // Keep MiniMax's unknown-model signal so its dedicated VLM fallback remains reachable.
  if (isMinimaxVlmModel(params.resolvedProvider, params.resolvedModel)) {
    throw new Error(`Unknown model: ${params.resolvedProvider}/${params.resolvedModel}`);
  }
  throw new Error(
    `Model does not support images: ${params.requestedProvider}/${params.requestedModel} ` +
      `(resolved ${params.model.provider}/${params.model.id} input: ${formatModelInputCapabilities(params.model.input)})`,
  );
}

async function prepareResolvedImageRuntime(
  params: ImageRuntimeParams,
  preparedRuntime: PreparedModelRuntimeSnapshot,
  resolvedModel: Model,
  authStorage: Awaited<ReturnType<typeof resolveModelAsync>>["authStorage"],
  modelRegistry: Awaited<ReturnType<typeof resolveModelAsync>>["modelRegistry"],
): Promise<PreparedImageRuntime> {
  let model = resolvedModel;
  const modelRuntime = getModelRegistryRuntime(modelRegistry);
  const bindPreparedModel = (candidate: Model): Model => {
    const requestModel = applySecretRefHeaderSentinels(candidate, params.cfg);
    const providerRuntimeHandle = resolveProviderRuntimePluginHandle({
      provider: requestModel.provider,
      modelId: requestModel.id,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      pluginMetadataSnapshot: preparedRuntime.metadataSnapshot,
    });
    return bindModelLlmRuntime(
      attachModelProviderRuntimePluginHandle(requestModel, providerRuntimeHandle),
      modelRuntime.llmRuntime,
    );
  };
  const apiKeyInfo = await getApiKeyForModelCore({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    store: params.authStore,
    secretSentinels: true,
  });
  params.signal?.throwIfAborted();
  if (
    providerUsesCredentialScopedModelMetadata({
      provider: model.provider,
      modelId: model.id,
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    })
  ) {
    const authProfileMode = resolveProviderModelMaterializationAuthMode(apiKeyInfo.mode);
    const authoritative = await resolveModelAsync(
      model.provider,
      model.id,
      params.agentDir,
      params.cfg,
      {
        authStorage,
        modelRegistry,
        skipAgentDiscovery: true,
        allowBundledStaticCatalogFallback: true,
        preparedModelRuntime: preparedRuntime,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        ...(apiKeyInfo.profileId
          ? { authProfileId: apiKeyInfo.profileId }
          : authProfileMode
            ? { authProfileMode }
            : {}),
      },
    );
    params.signal?.throwIfAborted();
    model = requireImageCapableModel({
      model: authoritative.model,
      resolvedProvider: model.provider,
      resolvedModel: model.id,
      requestedProvider: params.provider,
      requestedModel: params.model,
    });
  }
  // Bedrock's runtime client owns AWS credential-chain resolution. Keep the
  // empty sentinel out of auth storage and pass it through to the stream.
  if (
    !apiKeyInfo.apiKey?.trim() &&
    apiKeyInfo.mode === "aws-sdk" &&
    model.api === "bedrock-converse-stream"
  ) {
    return bindResolvedImageRuntime(params, "", bindPreparedModel(model));
  }
  let apiKey = requireApiKey(apiKeyInfo, model.provider);
  const runtimeAuth = await prepareProviderRuntimeAuth({
    provider: model.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      provider: model.provider,
      modelId: model.id,
      model,
      apiKey,
      authMode: apiKeyInfo.mode,
      profileId: apiKeyInfo.profileId,
    },
  });
  params.signal?.throwIfAborted();
  const preparedAuth = protectPreparedProviderRuntimeAuth({
    provider: model.provider,
    preparedAuth: runtimeAuth,
  });
  apiKey = preparedAuth?.apiKey?.trim() || apiKey;
  model = applyPreparedRuntimeAuthToModel(model, preparedAuth);
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return bindResolvedImageRuntime(params, apiKey, bindPreparedModel(model));
}

async function resolveImageRuntimeInternal(
  params: ImageRuntimeParams,
  selection: {
    plan: (metadata: PreparedModelRuntimeSnapshot["metadataSnapshot"]) => ModelRef;
    resolve: (runtime: PreparedModelRuntimeSnapshot) => ModelRef;
  },
  onAcquired: (resources: ImageRuntimeResources) => void,
): Promise<PreparedImageRuntime> {
  const workspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg ?? {}, params.agentId) : undefined);
  const runtimeParams = workspaceDir ? { ...params, workspaceDir } : params;
  const authProfileOptions = {
    ...(params.profile ? { authProfileId: params.profile } : {}),
    ...(params.preferredProfile ? { preferredProfile: params.preferredProfile } : {}),
  };
  const suppliedSnapshot = params.preparedModelRuntime as PreparedModelRuntimeSnapshot | undefined;
  const suppliedClaim = suppliedSnapshot
    ? retainPreparedModelRuntimeSnapshotResources(suppliedSnapshot)
    : undefined;
  const preparedRuntimeLease = suppliedSnapshot
    ? { snapshot: suppliedSnapshot, release: () => suppliedClaim?.release() }
    : await acquireAgentRunPreparedModelRuntime(
        {
          agentDir: params.agentDir,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          config: params.cfg ?? {},
          ...(runtimeParams.workspaceDir ? { workspaceDir: runtimeParams.workspaceDir } : {}),
          preserveWorkspaceDirOnRefresh: params.workspaceDir !== undefined,
          loadRuntimePlugins: true,
        },
        // The request already chose a model; full inventory discovery must stay outside setup.
        {
          catalogMode: "static",
          abortSignal: params.signal,
          deriveRuntimePluginSelections: ({ metadataSnapshot }) => {
            const ref = selection.plan(metadataSnapshot);
            return [{ provider: ref.provider, modelId: ref.model, agentId: params.agentId }];
          },
        },
      );
  // The operation owns release before setup can leave asynchronous cleanup behind.
  onAcquired({
    release: preparedRuntimeLease.release,
    ...(suppliedClaim ? { assertResourcesOpen: suppliedClaim.assertOpen } : {}),
  });
  params.signal?.throwIfAborted();
  const preparedRuntime = preparedRuntimeLease.snapshot;
  const preparedWorkspaceDir = preparedRuntime.workspaceDir ?? runtimeParams.workspaceDir;
  const preparedParams: ImageRuntimeParams = {
    ...runtimeParams,
    agentDir: preparedRuntime.agentDir,
    // Borrowed generations supply metadata; the caller owns any route-projected config.
    cfg: params.preparedModelRuntime ? params.cfg : preparedRuntime.config,
    preparedModelRuntime: preparedRuntime,
    ...(preparedWorkspaceDir ? { workspaceDir: preparedWorkspaceDir } : {}),
  };
  // Media request types carry this agent-owned handle opaquely to avoid importing the agent
  // runtime graph into provider contracts. This is the sole boundary that consumes its stores.
  const preparedStores = preparedRuntime.createStores() as Required<
    Pick<NonNullable<Parameters<typeof resolveModelAsync>[4]>, "authStorage" | "modelRegistry">
  >;
  const resolveOptions = {
    allowBundledStaticCatalogFallback: true,
    ...preparedStores,
    preparedModelRuntime: preparedRuntime,
    skipAgentDiscovery: true,
    ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
    ...authProfileOptions,
  };
  return await withPluginRuntimeGenerationScope(preparedRuntime, async () => {
    const resolvedRef = selection.resolve(preparedRuntime);
    try {
      const resolved = await resolveModelAsync(
        resolvedRef.provider,
        resolvedRef.model,
        preparedParams.agentDir,
        preparedParams.cfg,
        resolveOptions,
      );
      // Setup may have closed during model lookup; do not start auth for a late result.
      params.signal?.throwIfAborted();
      const model = requireImageCapableModel({
        model: resolved.model,
        resolvedProvider: resolvedRef.provider,
        resolvedModel: resolvedRef.model,
        requestedProvider: params.provider,
        requestedModel: params.model,
      });
      return await prepareResolvedImageRuntime(
        preparedParams,
        preparedRuntime,
        model,
        resolved.authStorage,
        resolved.modelRegistry,
      );
    } catch (error) {
      // A late unknown-model result must not start new auth work after setup closes.
      params.signal?.throwIfAborted();
      if (
        !isMinimaxVlmModel(resolvedRef.provider, resolvedRef.model) ||
        !isUnknownModelError(error)
      ) {
        throw error;
      }
      // Regional endpoints and auth retain the authored provider key, including its spelling.
      return await resolveMinimaxVlmFallbackRuntime({
        ...preparedParams,
        model: resolvedRef.model,
      });
    }
  });
}

/** Public image inputs are normalized only after their runtime is admitted. */
export function resolveImageRuntime(
  params: ImageRuntimeParams,
  onAcquired: (resources: ImageRuntimeResources) => void,
): Promise<PreparedImageRuntime> {
  return resolveImageRuntimeInternal(
    params,
    {
      plan: (metadata) =>
        normalizeModelRef(params.provider, params.model, {
          manifestPlugins: metadata,
          allowPluginNormalization: false,
        }),
      resolve: (runtime) =>
        normalizeModelRef(params.provider, params.model, {
          manifestPlugins: runtime.metadataSnapshot,
          resolvedModelCatalog: runtime.modelCatalog.entries,
        }),
    },
    onAcquired,
  );
}

/** Internal selected candidates retain their exact identity across every preparation stage. */
export function resolveImageRuntimeForModel(
  params: ImageRuntimeParams,
  onAcquired: (resources: ImageRuntimeResources) => void,
): Promise<PreparedImageRuntime> {
  const ref = { provider: params.provider, model: params.model };
  return resolveImageRuntimeInternal(params, { plan: () => ref, resolve: () => ref }, onAcquired);
}
