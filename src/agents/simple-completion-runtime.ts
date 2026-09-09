import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
/**
 * Simple completion runtime preparation.
 *
 * Resolves agent model selection, auth, runtime policy, and missing-auth errors before simple completions run.
 */
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  attachModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import {
  applySecretRefHeaderSentinels,
  applyLocalNoAuthHeaderOverride,
  formatMissingAuthError,
  getApiKeyForModelCore,
  resolveApiKeyForProviderCore,
  type ResolvedProviderAuth,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { resolveOpenAIModelRoutes, selectOpenAIModelRouteAuth } from "./openai-model-routes.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import {
  acquirePreparedModelSelection,
  withPreparedModelSelection,
  type PreparedModelSelectionContext,
} from "./prepared-model-selection.js";
import {
  buildProviderModelAuthDirectSource,
  buildProviderModelAuthSourcePlan,
} from "./provider-model-auth-source-plan.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-runtime-auth-protection.js";
import { buildAgentRuntimeAuthPlan } from "./runtime-plan/auth.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import type {
  AgentSimpleCompletionSelection,
  PreparedSimpleCompletionModel,
  PreparedSimpleCompletionModelForAgent,
  PrepareSimpleCompletionModelForAgentParams,
} from "./simple-completion.types.js";
import { resolveUtilityModelRefForAgent } from "./utility-model.js";

type PreparedSimpleCompletionResolverContext = Readonly<{
  modelResolver: typeof resolveModelAsync;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  workspaceDir: string;
}>;

/** Bind every resolution in one completion to one prepared generation and store pair. */
function createPreparedSimpleCompletionResolverContext(params: {
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  workspaceDir: string;
  modelResolver?: typeof resolveModelAsync;
  agentRuntimeId?: string;
}): PreparedSimpleCompletionResolverContext {
  const stores = params.preparedModelRuntime.createStores();
  const modelResolver = params.modelResolver ?? resolveModelAsync;
  return {
    preparedModelRuntime: params.preparedModelRuntime,
    workspaceDir: params.workspaceDir,
    modelResolver: (provider, modelId, agentDir, cfg, options) =>
      modelResolver(provider, modelId, agentDir, cfg, {
        ...options,
        authStorage: stores.authStorage,
        modelRegistry: stores.modelRegistry,
        preparedModelRuntime: params.preparedModelRuntime,
        workspaceDir: params.workspaceDir,
        ...(params.agentRuntimeId ? { agentRuntimeId: params.agentRuntimeId } : {}),
      }),
  };
}

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

type SimpleCompletionSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean;
  resolvedModelCatalog?: ModelManifestNormalizationContext["resolvedModelCatalog"];
  manifestPlugins?:
    | PluginMetadataSnapshot["plugins"]
    | Pick<PluginMetadataSnapshot, "plugins" | "owners">;
};

function resolveSimpleCompletionSelection(
  params: Omit<SimpleCompletionSelectionParams, "agentId"> & { agentId?: string },
  allowPluginNormalization = true,
): AgentSimpleCompletionSelection | null {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const primaryModelRef = params.agentId
    ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId)
    : resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
    resolvedModelCatalog: params.resolvedModelCatalog,
    allowPluginNormalization,
  });
  // Utility routing derives a provider-declared small model when unset and
  // treats an explicit empty utilityModel as "use the primary" (disabled).
  const modelRef =
    params.modelRef?.trim() ||
    (params.useUtilityModel
      ? resolveUtilityModelRefForAgent({
          cfg: params.cfg,
          agentId,
          primaryProvider: fallbackRef.provider,
          ...(params.manifestPlugins
            ? {
                metadataSnapshot:
                  "plugins" in params.manifestPlugins
                    ? params.manifestPlugins
                    : { plugins: params.manifestPlugins },
              }
            : {}),
        })
      : undefined) ||
    primaryModelRef;
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
    manifestPlugins: params.manifestPlugins,
    resolvedModelCatalog: params.resolvedModelCatalog,
    allowPluginNormalization,
  });
  const resolved = split
    ? resolveModelRefFromString({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        aliasIndex,
        manifestPlugins: params.manifestPlugins,
        resolvedModelCatalog: params.resolvedModelCatalog,
        allowPluginNormalization,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    provider,
    modelId,
    profileId: split?.profile || undefined,
    agentDir: params.agentDir?.trim() || resolveAgentDir(params.cfg, agentId),
  };
}

export function resolveSimpleCompletionSelectionForAgent(
  params: SimpleCompletionSelectionParams,
): AgentSimpleCompletionSelection | null {
  return resolveSimpleCompletionSelection(params);
}

export async function prepareSimpleCompletionModel(requestedParams: {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: typeof resolveModelAsync;
  /** Internal caller-owned generation. Public plugin callers use the agent helper below. */
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  workspaceDir?: string;
  agentRuntimeId?: string;
}): Promise<PreparedSimpleCompletionModel> {
  // Runtime admission may yield; this call keeps its submitted model and auth choices.
  const params = { ...requestedParams };
  const prepare = async (
    context: Pick<PreparedModelSelectionContext, "preparedModelRuntime" | "workspaceDir">,
  ) =>
    await prepareSimpleCompletionModelCore(
      {
        ...params,
        // Explicit generations may accompany route-projected transport/auth config.
        cfg: params.preparedModelRuntime ? params.cfg : context.preparedModelRuntime.config,
        agentDir: context.preparedModelRuntime.agentDir,
      },
      createPreparedSimpleCompletionResolverContext({
        ...context,
        modelResolver: params.modelResolver,
        agentRuntimeId: params.agentRuntimeId,
      }),
    );
  const preparedModelRuntime = params.preparedModelRuntime;
  if (preparedModelRuntime) {
    const cfg = params.cfg ?? {};
    const workspaceDir =
      params.workspaceDir ??
      preparedModelRuntime.workspaceDir ??
      resolveAgentWorkspaceDir(cfg, params.agentId ?? resolveDefaultAgentId(cfg));
    return await withPluginRuntimeGenerationScope(preparedModelRuntime, () =>
      prepare({ preparedModelRuntime, workspaceDir }),
    );
  }
  return await withPreparedModelSelection(
    params,
    [
      {
        provider: params.provider,
        modelId: params.modelId,
        ...(params.agentRuntimeId ? { runtime: params.agentRuntimeId } : {}),
      },
    ],
    prepare,
  );
}

async function prepareSimpleCompletionModelCore(
  params: Parameters<typeof prepareSimpleCompletionModel>[0],
  context: PreparedSimpleCompletionResolverContext,
): Promise<PreparedSimpleCompletionModel> {
  const { modelResolver, workspaceDir } = context;
  const resolved = await modelResolver(
    params.provider,
    params.modelId,
    params.agentDir,
    params.cfg,
    {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.allowBundledStaticCatalogFallback !== undefined
        ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
        : {}),
      ...(params.skipAgentDiscovery ? { skipAgentDiscovery: true } : {}),
      authProfileId: params.profileId,
      preferredProfile: params.preferredProfile,
    },
  );
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }
  const initialModel = resolved.model;
  let resolvedModel = initialModel;

  const routeResolution = resolveOpenAIModelRoutes({
    provider: initialModel.provider,
    modelId: initialModel.id,
    api: initialModel.api,
    baseUrl: initialModel.baseUrl,
    config: params.cfg,
    env: process.env,
  });
  const resolvesAuthBeforePhysicalRoute =
    routeResolution?.kind === "routes" && routeResolution.routes.length > 1;

  let auth: ResolvedProviderAuth;
  const authStore = params.bindAuthOwner
    ? ensureAuthProfileStore(params.agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
        config: params.cfg,
        profileId: params.profileId,
      })
    : undefined;
  const authOptions = {
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir,
    preferredProfile: params.preferredProfile,
    ...(authStore ? { store: authStore } : {}),
    ...(params.bindAuthOwner && params.profileId ? { lockedProfile: true } : {}),
    secretSentinels: true,
  };
  try {
    auth = resolvesAuthBeforePhysicalRoute
      ? await resolveApiKeyForProviderCore({
          provider: initialModel.provider,
          ...authOptions,
          profileId: params.profileId,
          modelId: initialModel.id,
        })
      : await getApiKeyForModelCore({
          model: initialModel,
          ...authOptions,
          profileId: params.profileId,
        });
    if (routeResolution?.kind === "routes") {
      const source = auth.profileId
        ? {
            kind: "profile" as const,
            profileId: auth.profileId,
            provider: initialModel.provider,
            mode: auth.mode,
            readiness: "ready" as const,
            cooldown: "clear" as const,
          }
        : buildProviderModelAuthDirectSource({
            mode: auth.mode,
            availability: true,
            evidence: "runtime",
            // The credential is already resolved by the caller and wrapped as
            // required provider-binding ownership below, so it is not an
            // ambient discovery competing with declared profiles.
            authorization: "declared",
          });
      const routeAuthDecision = selectOpenAIModelRouteAuth({
        resolution: routeResolution,
        sourcePlan: buildProviderModelAuthSourcePlan({
          ownership: { reason: "provider-binding", source },
          profiles: [],
        }),
      });
      if (routeAuthDecision.kind !== "selected") {
        throw new Error(
          routeAuthDecision.kind === "rejected"
            ? routeAuthDecision.message
            : "OpenAI route selection unexpectedly deferred after auth was resolved.",
        );
      }
      const route = routeAuthDecision.selection.route;
      const plan = buildAgentRuntimeAuthPlan({
        provider: initialModel.provider,
        modelId: initialModel.id,
        authProfileProvider: initialModel.provider,
        authProfileMode: auth.mode,
        sessionAuthProfileId: auth.profileId,
        sessionAuthProfileSource: params.profileId ? "user" : "auto",
        modelRoute: {
          provider: initialModel.provider,
          modelId: initialModel.id,
          api: route.api,
          baseUrl: route.baseUrl,
          authRequirement: route.authRequirement,
          requestTransportOverrides: route.requestTransportOverrides,
          runtimePolicy: route.runtimePolicy,
        },
        config: params.cfg,
        workspaceDir,
      });
      resolvedModel =
        (await materializePreparedRuntimeModel({
          plan,
          provider: initialModel.provider,
          modelId: initialModel.id,
          config: params.cfg,
          workspaceDir,
          metadataSnapshot: context.preparedModelRuntime.metadataSnapshot,
          model: initialModel,
          resolveModel: ({ config, authProfileId, authProfileMode }) =>
            modelResolver(initialModel.provider, initialModel.id, params.agentDir, config, {
              ...(params.agentId ? { agentId: params.agentId } : {}),
              skipAgentDiscovery: true,
              allowBundledStaticCatalogFallback: true,
              preferBundledStaticCatalogTransport: true,
              authProfileId,
              authProfileMode,
            }),
        })) ?? initialModel;
      if (resolvesAuthBeforePhysicalRoute) {
        auth = await getApiKeyForModelCore({
          model: resolvedModel,
          ...authOptions,
          profileId: auth.profileId,
        });
      }
    }
  } catch (err) {
    return {
      error: `Auth lookup failed for provider "${initialModel.provider}": ${formatErrorMessage(err)}`,
    };
  }
  const rawApiKey = auth.apiKey?.trim();
  if (!rawApiKey && !params.allowMissingApiKeyModes?.includes(auth.mode)) {
    return {
      error: formatMissingAuthError(auth, resolvedModel.provider),
      auth,
    };
  }

  let authValue = rawApiKey;
  if (rawApiKey) {
    const preparedAuth = protectPreparedProviderRuntimeAuth({
      provider: resolvedModel.provider,
      preparedAuth: await prepareProviderRuntimeAuth({
        provider: resolvedModel.provider,
        config: params.cfg,
        workspaceDir,
        env: process.env,
        context: {
          config: params.cfg,
          workspaceDir,
          env: process.env,
          provider: resolvedModel.provider,
          modelId: resolvedModel.id,
          model: resolvedModel,
          apiKey: rawApiKey,
          authMode: auth.mode,
          profileId: auth.profileId,
        },
      }),
    });
    authValue = preparedAuth?.apiKey?.trim() || rawApiKey;
    resolved.authStorage.setRuntimeApiKey(resolvedModel.provider, authValue);
    resolvedModel = applyPreparedRuntimeAuthToModel(resolvedModel, preparedAuth);
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: authValue,
  };
  const profileCredential = params.profileId ? authStore?.profiles[params.profileId] : undefined;
  const sourceAuthFingerprint = params.bindAuthOwner
    ? profileCredential?.type === "oauth" && params.profileId
      ? fingerprintAuthProfileCredential({
          profileId: params.profileId,
          credential: profileCredential,
        })
      : fingerprintResolvedProviderAuth(auth)
    : undefined;
  const modelRuntime = getModelRegistryRuntime(resolved.modelRegistry);
  const model = applySecretRefHeaderSentinels(
    applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
    params.cfg,
  );
  const providerRuntimeHandle = resolveProviderRuntimePluginHandle({
    provider: model.provider,
    modelId: model.id,
    config: params.cfg,
    workspaceDir,
    env: process.env,
    pluginMetadataSnapshot: context.preparedModelRuntime.metadataSnapshot,
  });
  const preparedModel = attachModelProviderRuntimePluginHandle(model, providerRuntimeHandle);
  // Capture this generation's transport hooks while keeping the logical model API
  // visible to callers that build prompts before dispatch.
  const completionTransport = attachModelProviderRuntimePluginHandle(
    prepareModelForSimpleCompletion({
      apiRegistry: modelRuntime.apiRegistry,
      model: preparedModel,
      cfg: params.cfg,
    }),
    providerRuntimeHandle,
  );

  return {
    model: bindModelLlmRuntime(preparedModel, modelRuntime.llmRuntime, completionTransport),
    auth: resolvedAuth,
    ...(sourceAuthFingerprint ? { sourceAuthFingerprint } : {}),
  };
}

type SimpleCompletionSelectionParamsWithRuntime = Omit<
  SimpleCompletionSelectionParams,
  "agentId"
> & {
  agentId?: string;
  modelResolver?: typeof resolveModelAsync;
  workspaceDir?: string;
  readOnly?: boolean;
  abortSignal?: AbortSignal;
};
type SimpleCompletionSelectionContext = PreparedModelSelectionContext &
  PreparedSimpleCompletionResolverContext;
type SimpleCompletionSelectionConsumer<T> = (
  selection: AgentSimpleCompletionSelection | null,
  context: SimpleCompletionSelectionContext,
) => Promise<T>;

async function acquireSimpleCompletionSelection(
  requestedParams: SimpleCompletionSelectionParamsWithRuntime,
) {
  const params = { ...requestedParams };
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const acquired = await acquirePreparedModelSelection(
    { ...params, agentId },
    ({ config, metadataSnapshot }) => {
      const selection = resolveSimpleCompletionSelection(
        { ...params, cfg: config, manifestPlugins: metadataSnapshot },
        false,
      );
      return selection
        ? [{ provider: selection.provider, modelId: selection.modelId, agentId }]
        : [];
    },
  );
  return {
    release: acquired.release,
    assertCurrent: acquired.assertCurrent,
    run: <T>(run: SimpleCompletionSelectionConsumer<T>) =>
      acquired.run(async (context) => {
        const runtime = context.preparedModelRuntime;
        const selection = resolveSimpleCompletionSelection({
          ...params,
          cfg: runtime.config,
          agentDir: runtime.agentDir,
          manifestPlugins: runtime.metadataSnapshot,
          resolvedModelCatalog: runtime.modelCatalog.entries,
        });
        return await run(selection, {
          ...context,
          ...createPreparedSimpleCompletionResolverContext({
            ...context,
            modelResolver: params.modelResolver,
          }),
        });
      }),
  };
}

/** Resolve authored input once inside its selected runtime, before auth or execution. */
export async function withPreparedSimpleCompletionSelection<T>(
  params: SimpleCompletionSelectionParamsWithRuntime,
  run: SimpleCompletionSelectionConsumer<T>,
): Promise<T> {
  const acquired = await acquireSimpleCompletionSelection(params);
  try {
    return await acquired.run(run);
  } finally {
    acquired.release();
  }
}

type ValidateSimpleCompletionSelection = (params: {
  selection: Readonly<AgentSimpleCompletionSelection>;
  config: OpenClawConfig;
}) => undefined;
/** Keeps admitted facts alive until the internal completion owner releases them. */
export async function acquireSimpleCompletionModelForAgent(
  requestedParams: Parameters<typeof prepareSimpleCompletionModelFromRef>[0] & {
    abortSignal?: AbortSignal;
  },
  validateSelection?: ValidateSimpleCompletionSelection,
) {
  const params = { ...requestedParams };
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const acquired = await acquireSimpleCompletionSelection(params);
  let transferred = false;
  try {
    const result = await acquired.run(async (selection, context) => {
      const runtime = context.preparedModelRuntime;
      if (!selection) {
        return { error: `No model configured for agent ${agentId}.` };
      }
      validateSelection?.({ selection, config: runtime.config });
      const prepared = await prepareSimpleCompletionModelCore(
        {
          ...params,
          cfg: runtime.config,
          agentId,
          provider: selection.provider,
          modelId: selection.modelId,
          agentDir: selection.agentDir,
          profileId: selection.profileId,
        },
        context,
      );
      return "error" in prepared
        ? { ...prepared, selection }
        : { ...prepared, selection, config: runtime.config };
    });
    if (result.error !== undefined) {
      return result;
    }
    transferred = true;
    return { ...result, release: acquired.release, assertCurrent: acquired.assertCurrent };
  } finally {
    if (!transferred) {
      acquired.release();
    }
  }
}

/** Without agentId, select global model defaults while the default agent owns execution. */
export async function prepareSimpleCompletionModelFromRef(
  requestedParams: Omit<PrepareSimpleCompletionModelForAgentParams, "agentId"> & {
    agentId?: string;
  },
  validateSelection?: ValidateSimpleCompletionSelection,
): Promise<PreparedSimpleCompletionModelForAgent> {
  const acquired = await acquireSimpleCompletionModelForAgent(requestedParams, validateSelection);
  if ("error" in acquired) {
    return acquired;
  }
  const { config: _config, assertCurrent: _assertCurrent, release, ...prepared } = acquired;
  release();
  return prepared;
}

export { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";
