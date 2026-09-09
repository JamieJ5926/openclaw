import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderRouteOverridePresence } from "../plugin-sdk/provider-model-types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type MergedModelProviderEntry = {
  providerKey: string;
  providerConfig: ModelProviderConfig;
};

/** Read provider config overrides without renormalizing the selected identity. */
export function findProviderModelConfig<T extends { id?: string }>(
  models: readonly T[] | undefined,
  provider: string,
  modelId: string,
  canonicalizeModelId?: (modelId: string) => string,
): T | undefined {
  const rows = resolveRawProviderModelConfigs({
    models,
    provider,
    normalizeModelId: (id) => normalizeConfiguredProviderCatalogModelId(provider, id.trim()),
  });
  const exact = rows.get(modelId);
  if (exact || !canonicalizeModelId) {
    return exact;
  }
  const canonicalId = canonicalizeModelId(modelId);
  const canonical = rows.get(canonicalId);
  if (canonical) {
    return canonical;
  }
  for (const [id, row] of rows) {
    if (canonicalizeModelId(id) === canonicalId) {
      return row;
    }
  }
  return undefined;
}

const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "arcee",
  "azure-openai-responses",
  "byteplus",
  "byteplus-plan",
  "cerebras",
  "chutes",
  "claude-cli",
  "clawrouter",
  "cloudflare-ai-gateway",
  "codex",
  "comfy",
  "copilot-proxy",
  "dashscope",
  "deepinfra",
  "deepseek",
  "fal",
  "fireworks",
  "github-copilot",
  "gmi",
  "gmi-cloud",
  "gmicloud",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kilocode",
  "kimi",
  "kimi-coding",
  "litellm",
  "lmstudio",
  "meta",
  "microsoft-foundry",
  "minimax",
  "minimax-portal",
  "mistral",
  "modelstudio",
  "moonshot",
  "moonshot-ai",
  "moonshotai",
  "nvidia",
  "novita",
  "novita-ai",
  "novitaai",
  "ollama",
  "ollama-cloud",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "qwen",
  "qwen-token-plan",
  "qwencloud",
  "sglang",
  "stepfun",
  "stepfun-plan",
  "synthetic",
  "tencent-tokenhub",
  "tencent-tokenplan",
  "together",
  "venice",
  "vercel-ai-gateway",
  "vllm",
  "volcengine",
  "volcengine-plan",
  "vydra",
  "x-ai",
  "xai",
  "xiaomi",
  "xiaomi-token-plan",
  "z.ai",
  "z-ai",
  "zai",
]);

/** Identifies provider overlays already known to the bundled config contract. */
export function isBuiltInModelProviderOverlayId(providerId: string): boolean {
  return BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS.has(normalizeProviderId(providerId));
}

/** Indexes exact configured model rows and caller-owned model-id equivalents. */
export function resolveMergedModelProviderModels<T extends { id?: string }>(params: {
  models: readonly T[] | undefined;
  normalizeModelId: (modelId: string) => string | undefined;
}): ReadonlyMap<string, T> {
  const models = new Map<string, T>();
  const exactRows: Array<{ model: T; id: string }> = [];
  for (const model of params.models ?? []) {
    const rawId = model?.id;
    if (typeof rawId !== "string") {
      continue;
    }
    const modelId = params.normalizeModelId(rawId);
    if (!modelId) {
      continue;
    }
    exactRows.push({ model, id: rawId.trim() });
    const existing = models.get(modelId);
    models.set(modelId, existing ? { ...model, ...existing } : model);
  }
  // Resolved IDs may themselves be input aliases. Keep their exact rows ahead
  // of normalized aliases; reverse order preserves first-row fields and lets
  // later exact duplicates fill omissions before aliases do.
  for (const { model, id: modelId } of exactRows.toReversed()) {
    const existing = models.get(modelId);
    models.set(modelId, existing && existing !== model ? { ...existing, ...model } : model);
  }
  return models;
}

/** Legacy provider-prefix spellings are config fallbacks, never catalog identities. */
function resolveRawProviderModelConfigs<T extends { id?: string }>(params: {
  models: readonly T[] | undefined;
  provider: string;
  normalizeModelId: (modelId: string) => string | undefined;
}): ReadonlyMap<string, T> {
  const models = new Map(resolveMergedModelProviderModels(params));
  const provider = normalizeProviderId(params.provider);
  for (const model of params.models ?? []) {
    const id = model.id?.trim() ?? "";
    const slash = id.indexOf("/");
    if (slash <= 0 || normalizeProviderId(id.slice(0, slash)) !== provider) {
      continue;
    }
    const legacyId = id.slice(slash + 1).trim();
    // An exact or declared-equivalent row owns even its omitted and empty fields.
    if (legacyId && !models.has(legacyId)) {
      models.set(legacyId, models.get(id) ?? model);
    }
  }
  return models;
}

function hasNonEmptyRecord(value: unknown): boolean {
  const record = readRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function hasRequestCompatOverrides(compat: ModelDefinitionConfig["compat"]): boolean {
  return Object.entries(compat ?? {}).some(([key, value]) => {
    // Native runtimes consume affirmative reasoning capabilities as turn controls.
    // Disabling reasoning, custom labels, and payload shaping still require the authored adapter.
    if (key === "supportsReasoningEffort") {
      return value !== true;
    }
    if (key === "supportedReasoningEfforts") {
      return !(
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (effort) =>
            typeof effort === "string" &&
            /^(minimal|low|medium|high|xhigh|max|ultra)$/u.test(effort),
        )
      );
    }
    return true;
  });
}

/** Prepares row lookups within one stable authored config view. */
export function createModelProviderRouteOverrideResolver(params: {
  provider: string;
  authoredConfig?: OpenClawConfig;
  canonicalizeModelId?: (modelId: string) => string;
}): (modelId?: string) => ProviderRouteOverridePresence {
  const providerConfig = resolveMergedModelProviderConfig(params.authoredConfig, params.provider);
  if (!providerConfig) {
    return () => "none";
  }
  if (
    readRecord(providerConfig.localService) !== undefined ||
    hasNonEmptyRecord(providerConfig.headers) ||
    hasNonEmptyRecord(providerConfig.request) ||
    hasNonEmptyRecord(providerConfig.params) ||
    typeof providerConfig.authHeader === "boolean" ||
    typeof providerConfig.timeoutSeconds === "number"
  ) {
    return () => "present";
  }
  const canonicalize = (modelId: string) => {
    const normalized = modelId.trim();
    const canonical = params.canonicalizeModelId?.(normalized).trim();
    return canonical || normalized;
  };
  const normalizeConfiguredModelId = params.canonicalizeModelId
    ? canonicalize
    : (modelId: string) =>
        normalizeConfiguredProviderCatalogModelId(params.provider, modelId.trim());
  let configuredModels: ReadonlyMap<string, ModelDefinitionConfig> | undefined;
  return (modelId) => {
    if (!modelId) {
      return "none";
    }
    // Only authored rows need input normalization. Resolved targets retain their
    // identity unless the provider explicitly supplies catalog equivalence.
    const canonicalModelId = canonicalize(modelId);
    const configuredModel = (configuredModels ??= resolveRawProviderModelConfigs({
      models: providerConfig.models,
      provider: params.provider,
      normalizeModelId: normalizeConfiguredModelId,
    })).get(canonicalModelId);
    return configuredModel &&
      (hasNonEmptyRecord(configuredModel.headers) ||
        hasNonEmptyRecord(configuredModel.params) ||
        hasRequestCompatOverrides(configuredModel.compat))
      ? "present"
      : "none";
  };
}

/** Resolves the provider entry produced by models-config key normalization. */
export function resolveMergedModelProviderEntry(
  config: OpenClawConfig | undefined,
  provider: string,
): MergedModelProviderEntry | undefined {
  const requestedProvider = provider.trim();
  const normalizedProvider = normalizeProviderId(requestedProvider);
  if (!normalizedProvider) {
    return undefined;
  }
  const providers = Object.entries(config?.models?.providers ?? {});
  // normalizeProviders trims keys but does not lowercase them. Preserve its
  // exact-key precedence, then use the existing case-insensitive fallback.
  const exactKey = providers.find(([providerId]) => providerId.trim() === requestedProvider)?.[0];
  const fallbackKey = providers.find(
    ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
  )?.[0];
  const providerKey = (exactKey ?? fallbackKey)?.trim();
  if (!providerKey) {
    return undefined;
  }
  let matched: ModelProviderConfig | undefined;
  for (const [providerId, providerConfig] of providers) {
    if (providerId.trim() !== providerKey) {
      continue;
    }
    // Match normalizeProviders: later fields win, while omitted model rows keep
    // the earlier catalog instead of erasing it from route/auth decisions.
    matched = matched
      ? {
          ...matched,
          ...providerConfig,
          models: providerConfig.models ?? matched.models,
        }
      : providerConfig;
  }
  return matched ? { providerKey, providerConfig: matched } : undefined;
}

/** Resolves only the merged provider config when its canonical key is not needed. */
export function resolveMergedModelProviderConfig(
  config: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return resolveMergedModelProviderEntry(config, provider)?.providerConfig;
}

/** Projects a resolved request onto one transient canonical provider entry. */
export function projectModelProviderConfig(
  config: OpenClawConfig | undefined,
  providerId: string,
  overrides: Pick<ModelProviderConfig, "baseUrl"> &
    Partial<Pick<ModelProviderConfig, "api" | "auth">>,
): OpenClawConfig {
  const provider = normalizeProviderId(providerId);
  const entry = resolveMergedModelProviderEntry(config, provider);
  const providerKey = entry?.providerKey ?? provider;
  const providers = Object.fromEntries(
    Object.entries(config?.models?.providers ?? {}).filter(
      ([candidate]) => normalizeProviderId(candidate) !== provider || candidate === providerKey,
    ),
  );
  return {
    ...config,
    models: {
      ...config?.models,
      providers: {
        ...providers,
        [providerKey]: { ...(entry?.providerConfig ?? { models: [] }), ...overrides },
      },
    },
  };
}
