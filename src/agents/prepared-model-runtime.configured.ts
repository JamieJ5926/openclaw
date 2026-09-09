import {
  collectConfiguredModelRefs,
  type ConfiguredModelRef,
} from "@openclaw/model-catalog-core/configured-model-refs";
import {
  parseModelCatalogRef,
  type ModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderModels } from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  normalizePluginDiscoveryResult,
  type PreparedProviderStaticCatalog,
} from "../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import {
  buildInlineProviderModels,
  completeInlineProviderModel,
  type InlineModelEntry,
} from "./embedded-agent-runner/model.inline-provider.js";
import {
  findStaticModel,
  type StaticModelIdNormalizer,
} from "./embedded-agent-runner/model.static-id.js";
import { resolveConfiguredModelHarnessRuntime } from "./harness-runtimes.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";
import { resolveEffectiveAgentRuntime } from "./thinking-runtime.js";

export type PreparedConfiguredRuntimeModel = Readonly<{
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
}>;

/**
 * A concrete runtime contract attached to the logical provider/model ref that
 * selects it. Prepared catalog rows retain this fact after runtime-only rows
 * are intentionally omitted from the configured view.
 */
export type PreparedRuntimeCapabilityModel = PreparedConfiguredRuntimeModel;

function findConfiguredStaticModel<T extends { id: string; provider?: string }>(
  models: readonly T[],
  provider: string,
  modelId: string,
  normalizeModelId: StaticModelIdNormalizer,
): T | undefined {
  return (
    findStaticModel(models, provider, modelId) ??
    findStaticModel(models, provider, normalizeModelId(provider, modelId))
  );
}

function resolveConfiguredStaticModel(
  params: {
    resolveStaticCatalogModel: (lookup: ModelCatalogRef) => ProviderRuntimeModel | undefined;
    normalizeModelId: StaticModelIdNormalizer;
  },
  provider: string,
  modelId: string,
): ProviderRuntimeModel | undefined {
  return (
    params.resolveStaticCatalogModel({ provider, modelId }) ??
    params.resolveStaticCatalogModel({
      provider,
      modelId: params.normalizeModelId(provider, modelId),
    })
  );
}

/** Collects defaults, global refs, and only the selected agent's overrides. */
export function collectPreparedModelRuntimeConfiguredRefs(
  config: OpenClawConfig,
  agentId: string | undefined,
): ConfiguredModelRef[] {
  if (!agentId) {
    return collectConfiguredModelRefs(config);
  }
  const entry = resolveAgentEntry(config, agentId);
  return collectConfiguredModelRefs({
    ...config,
    agents: {
      ...(config.agents?.defaults ? { defaults: config.agents.defaults } : {}),
      list: entry ? [entry] : [],
    },
  });
}

export function collectPreparedModelRuntimeProviderIds(
  config: OpenClawConfig,
  credentials: Readonly<AuthStorageData>,
  includeCredentialProviders: boolean,
  configuredModelRefs: readonly ConfiguredModelRef[] = collectConfiguredModelRefs(config),
  agentId?: string,
): string[] {
  const providerIds = new Set<string>();
  const addProviderId = (value: string) => {
    const providerId = normalizeProviderId(value);
    if (providerId) {
      providerIds.add(providerId);
    }
  };
  if (includeCredentialProviders) {
    for (const providerId of Object.keys(credentials)) {
      addProviderId(providerId);
    }
  }
  for (const ref of configuredModelRefs) {
    const separator = ref.value.indexOf("/");
    if (separator > 0) {
      addProviderId(ref.value.slice(0, separator));
    }
    addProviderId(
      resolveConfiguredModelHarnessRuntime({
        config,
        modelRef: ref.value,
        agentId,
        includeImplicitRuntimePreferences: false,
      }) ?? "",
    );
  }
  return [...providerIds].toSorted((left, right) => left.localeCompare(right));
}

function hasConfiguredInlineProviderModel(
  config: OpenClawConfig,
  provider: string,
  modelId: string,
  normalizeModelId: StaticModelIdNormalizer,
): boolean {
  return Object.entries(config.models?.providers ?? {}).some(
    ([providerId, providerConfig]) =>
      normalizeProviderId(providerId) === provider &&
      resolveMergedModelProviderModels({
        models: providerConfig.models,
        normalizeModelId: (id) => normalizeModelId(provider, id),
      }).has(modelId),
  );
}

export function collectConfiguredProviderIdsNeedingStaticCatalog(params: {
  config: OpenClawConfig;
  configuredModelRefs?: readonly ConfiguredModelRef[];
  resolveStaticCatalogModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
  normalizeModelId: StaticModelIdNormalizer;
}): string[] {
  const providerIds = new Set<string>();
  for (const { value } of params.configuredModelRefs ?? collectConfiguredModelRefs(params.config)) {
    const parsed = parseModelCatalogRef(value);
    if (!parsed) {
      continue;
    }
    const { provider, modelId } = parsed;
    if (
      hasConfiguredInlineProviderModel(params.config, provider, modelId, params.normalizeModelId) ||
      resolveConfiguredStaticModel(params, provider, modelId)
    ) {
      continue;
    }
    providerIds.add(provider);
  }
  return [...providerIds].toSorted((left, right) => left.localeCompare(right));
}

export function prepareConfiguredRuntimeModels(params: {
  config: OpenClawConfig;
  inlineProviderModels: readonly InlineModelEntry[];
  configuredModelRefs: readonly ModelCatalogRef[];
  metadataSnapshot: PluginMetadataSnapshot;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerStaticModels: readonly ProviderRuntimeModel[];
  resolveStaticCatalogModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
  normalizeModelId: StaticModelIdNormalizer;
}): PreparedConfiguredRuntimeModel[] {
  const prepared: PreparedConfiguredRuntimeModel[] = [];
  const seen = new Set<string>();
  for (const { modelId, provider } of params.configuredModelRefs) {
    const key = resolveModelCatalogIdentityKey({ provider, id: modelId });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Match request-time fallback precedence exactly: manifest/runtime-discovery rows win,
    // and the provider-static catalog fills only models absent from that surface.
    let model =
      resolveConfiguredStaticModel(params, provider, modelId) ??
      findPreparedProviderStaticCatalogModel({
        prepared: params.preparedStaticProviderCatalog,
        metadataSnapshot: params.metadataSnapshot,
        provider,
        modelId,
        normalizeModelId: params.normalizeModelId,
      }) ??
      findConfiguredStaticModel(
        params.providerStaticModels,
        provider,
        modelId,
        params.normalizeModelId,
      );
    if (!model) {
      const catalogIds = new Set<string>();
      const inlineModels = resolveMergedModelProviderModels({
        models: params.inlineProviderModels.filter(
          (entry) => normalizeProviderId(entry.provider) === provider,
        ),
        normalizeModelId: (id) => {
          const resolvedId = params.normalizeModelId(provider, id.trim());
          catalogIds.add(resolvedId);
          return resolvedId;
        },
      });
      // Config retains authored aliases. Match their catalog IDs before resolving
      // a raw selector, then carry that executable identity into the runtime model.
      const inlineModelId = catalogIds.has(modelId)
        ? modelId
        : params.normalizeModelId(provider, modelId);
      const inlineModel = inlineModels.get(inlineModelId);
      const providerConfig =
        inlineModel &&
        findNormalizedProviderValue(params.config.models?.providers, inlineModel.provider);
      // Excluding an implicit catalog must not discard an authored transport definition.
      // Missing authored API metadata remains unresolved, matching request-time inline lookup.
      if (inlineModel?.api && providerConfig) {
        model = completeInlineProviderModel({ ...inlineModel, id: inlineModelId }, providerConfig);
      }
    }
    if (model) {
      prepared.push({ provider, modelId, model });
    }
  }
  return prepared;
}

/** Resolve concrete runtime capabilities once while materializing agent facts. */
export function prepareRuntimeCapabilityModels(params: {
  config: OpenClawConfig;
  agentId?: string;
  candidates: readonly ModelCatalogEntry[];
  resolveRuntimeModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
}): PreparedRuntimeCapabilityModel[] {
  const prepared: PreparedRuntimeCapabilityModel[] = [];
  const seen = new Set<string>();
  for (const candidate of params.candidates) {
    const provider = normalizeProviderId(candidate.provider);
    const modelId = candidate.id.trim();
    if (!provider || !modelId) {
      continue;
    }
    const runtime = resolveEffectiveAgentRuntime({
      cfg: params.config,
      provider,
      modelId,
      modelApi: candidate.api,
      modelBaseUrl: candidate.baseUrl,
      agentId: params.agentId,
    });
    if (runtime === provider || runtime === "openclaw") {
      continue;
    }
    const key = resolveModelCatalogIdentityKey({ provider, id: modelId });
    if (seen.has(key)) {
      continue;
    }
    const model = params.resolveRuntimeModel({ provider: runtime, modelId });
    if (!model) {
      continue;
    }
    seen.add(key);
    prepared.push({ provider, modelId, model });
  }
  return prepared;
}

function findPreparedProviderStaticCatalogModel(params: {
  prepared: PreparedProviderStaticCatalog | undefined;
  metadataSnapshot: PluginMetadataSnapshot;
  provider: string;
  modelId: string;
  normalizeModelId: StaticModelIdNormalizer;
}): ProviderRuntimeModel | undefined {
  if (!params.prepared) {
    return undefined;
  }
  for (const { provider, result } of params.prepared.entries) {
    for (const [providerId, providerConfig] of Object.entries(
      normalizePluginDiscoveryResult({ provider, result }),
    )) {
      if (normalizeProviderId(providerId) !== normalizeProviderId(params.provider)) {
        continue;
      }
      const model = findConfiguredStaticModel(
        providerConfig.models ?? [],
        params.provider,
        params.modelId,
        params.normalizeModelId,
      );
      if (!model) {
        continue;
      }
      const [resolved] = buildInlineProviderModels(
        { [providerId]: { ...providerConfig, models: [model] } },
        { providerMetadataOwners: params.metadataSnapshot.owners },
      );
      if (resolved) {
        return resolved as ProviderRuntimeModel;
      }
    }
  }
  return undefined;
}
