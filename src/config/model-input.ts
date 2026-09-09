// Normalizes model input config into provider and model references.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeConfiguredProviderCatalogModelRef,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import {
  normalizeGooglePreviewModelId,
  normalizeTogetherModelId,
} from "@openclaw/model-catalog-core/provider-model-id-normalize";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { modelKey } from "../shared/model-key.js";
import { resolveMergedModelProviderModels } from "./model-provider-config.js";
import type { AgentModelEntryConfig } from "./types.agent-defaults.js";
import type { AgentModelConfig, AgentToolModelConfig } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
};

type AgentModelInput = AgentModelConfig | AgentToolModelConfig;

/** Resolve settings keys without equating distinct provider-local model namespaces. */
export function resolveAgentModelConfigKeys(
  provider: string,
  model: string,
): [string, ...string[]] {
  const providerId = normalizeProviderId(provider);
  const modelId = model.trim();
  const keys: [string, ...string[]] = [modelKey(providerId, modelId)];
  const prefix = `${providerId}/`;
  // Documented short router refs remain valid settings keys only when the
  // provider's prepared normalization policy proves they name this exact model.
  if (
    modelId.startsWith(prefix) &&
    normalizeConfiguredProviderCatalogModelId(providerId, modelId.slice(prefix.length)) === modelId
  ) {
    keys.push(modelId);
  }
  return keys;
}

/** Read per-model settings through the same canonical and provider-owned alias keys. */
export function resolveAgentModelConfigValue<T, TValue>(
  models: Record<string, T> | undefined,
  provider: string,
  model: string,
  readValue: (entry: T) => TValue | undefined,
): TValue | undefined {
  const providerId = normalizeProviderId(provider);
  const modelId = model.trim();
  const direct = models?.[modelKey(providerId, modelId)];
  const value = direct !== undefined ? readValue(direct) : undefined;
  if (value !== undefined && value !== null) {
    return value;
  }
  // Omitted fields may inherit from aliases. The row owner still ranks exact
  // model IDs ahead of aliases across normalized provider spellings.
  const candidates = Object.entries(models ?? {}).flatMap(([key, entry]) => {
    const ref = parseModelCatalogRef(key);
    if (!ref || normalizeProviderId(ref.provider) !== providerId) {
      return [];
    }
    const candidateValue = readValue(entry);
    return candidateValue !== undefined && candidateValue !== null
      ? [{ id: ref.modelId, value: candidateValue }]
      : [];
  });
  // These full-ref settings keys do not inherit provider-row legacy prefix spellings.
  return resolveMergedModelProviderModels({
    models: candidates,
    normalizeModelId: (id) => normalizeConfiguredProviderCatalogModelId(providerId, id.trim()),
  }).get(modelId)?.value;
}

/** Returns the primary model ref from either string or object-style agent model config. */
export function resolveAgentModelPrimaryValue(model?: AgentModelInput): string | undefined {
  return resolvePrimaryStringValue(model);
}

/** Returns configured fallback model refs, preserving their configured order. */
export function resolveAgentModelFallbackValues(model?: AgentModelInput): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

/** Returns a positive finite tool timeout rounded down to whole milliseconds. */
export function resolveAgentModelTimeoutMsValue(model?: AgentToolModelConfig): number | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return typeof model.timeoutMs === "number" &&
    Number.isFinite(model.timeoutMs) &&
    model.timeoutMs > 0
    ? Math.floor(model.timeoutMs)
    : undefined;
}

/** Converts legacy string model config into the object shape used by model patch helpers. */
export function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined {
  if (typeof model === "string") {
    const primary = normalizeOptionalString(model);
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}

const GOOGLE_PROVIDER_IDS = new Set(["google", "google-gemini-cli", "google-vertex"]);

function normalizeRetiredProviderModelId(provider: string, model: string): string {
  return GOOGLE_PROVIDER_IDS.has(provider) || model.startsWith("google/")
    ? normalizeGooglePreviewModelId(model)
    : provider === "together"
      ? normalizeTogetherModelId(model)
      : model;
}

/** Canonicalizes provider/model refs before they are persisted to config. */
export function normalizeAgentModelRefForConfig(model: string): string {
  const trimmed = model.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return trimmed;
  }

  const { provider, modelId: modelSuffix } = parsed;
  return modelKey(provider, normalizeRetiredProviderModelId(provider, modelSuffix));
}

/** Apply named retirement migrations without reinterpreting provider input aliases. */
export function normalizeProviderCatalogModelIdForConfig(provider: string, model: string): string {
  return normalizeConfiguredProviderCatalogModelRef(
    normalizeRetiredProviderModelId(normalizeProviderId(provider), model),
  );
}

/** Normalizes primary/fallback refs without replacing unchanged config values. */
export function normalizeAgentModelSelectionForConfig(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeAgentModelRefForConfig(value);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  let next = value;
  const assign = (key: string, candidate: unknown) => {
    if (candidate !== next[key]) {
      next = { ...next, [key]: candidate };
    }
  };
  if (typeof value.primary === "string") {
    assign("primary", normalizeAgentModelRefForConfig(value.primary));
  }
  if (Array.isArray(value.fallbacks)) {
    const originalFallbacks = value.fallbacks;
    const fallbacks = originalFallbacks.map((fallback) =>
      typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback,
    );
    if (fallbacks.some((fallback, index) => fallback !== originalFallbacks[index])) {
      assign("fallbacks", fallbacks);
    }
  }
  return next;
}

export function mergeAgentModelEntryForConfig(
  existing: AgentModelEntryConfig | undefined,
  incoming: AgentModelEntryConfig,
): AgentModelEntryConfig;
export function mergeAgentModelEntryForConfig(existing: unknown, incoming: unknown): unknown;
export function mergeAgentModelEntryForConfig(existing: unknown, incoming: unknown): unknown {
  if (!isPlainRecord(existing) || !isPlainRecord(incoming)) {
    return incoming;
  }

  const existingParams = isPlainRecord(existing.params) ? existing.params : undefined;
  const incomingParams = isPlainRecord(incoming.params) ? incoming.params : undefined;
  return {
    ...existing,
    ...incoming,
    ...(existingParams || incomingParams
      ? { params: { ...existingParams, ...incomingParams } }
      : undefined),
  };
}

/** Normalizes model map keys and merges entries that collapse to the same canonical ref. */
export function normalizeAgentModelMapForConfig<T extends Record<string, unknown>>(models: T): T {
  let mutated = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(models)) {
    const normalizedKey = normalizeAgentModelRefForConfig(key);
    if (normalizedKey !== key || Object.hasOwn(next, normalizedKey)) {
      mutated = true;
    }
    // Later entries win, but nested params merge so provider defaults are not discarded.
    next[normalizedKey] = mergeAgentModelEntryForConfig(next[normalizedKey], entry);
  }
  return (mutated ? next : models) as T;
}
