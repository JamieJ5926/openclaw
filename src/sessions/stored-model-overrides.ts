// Resolves persisted per-session model choices across child and parent sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../agents/model-fallback.types.js";
import { resolvePersistedOverrideModelRef } from "../agents/model-selection-persisted.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import {
  hasSessionActiveAutoModelFallback,
  resolveSessionModelOverrideRouteResolution,
} from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
  /** Stored-input provenance; the public normalized view retains this original marker. */
  routeResolution: ModelFallbackRouteResolution;
};

type StoredModelOverrideReadParams = {
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
};

function readStoredOverrideFromEntry(
  entry: SessionEntry | undefined,
  source: StoredModelOverride["source"],
): StoredModelOverride | null {
  if (entry?.modelOverrideSource === "default") {
    return null;
  }
  const model = normalizeOptionalString(entry?.modelOverride);
  return model
    ? {
        provider: normalizeOptionalString(entry?.providerOverride),
        model,
        source,
        routeResolution: resolveSessionModelOverrideRouteResolution(entry),
      }
    : null;
}

function resolveParentSessionKeyCandidate(params: {
  sessionKey?: string;
  parentSessionKey?: string;
}): string | null {
  const explicit = normalizeOptionalString(params.parentSessionKey);
  if (explicit && explicit !== params.sessionKey) {
    return explicit;
  }
  const derived = resolveSessionParentSessionKey(params.sessionKey);
  if (derived && derived !== params.sessionKey) {
    return derived;
  }
  return null;
}

/** Read stored input without normalizing it before the operation's selection owner. */
export function readStoredModelOverride(
  params: StoredModelOverrideReadParams,
): StoredModelOverride | null {
  if (params.sessionEntry?.modelOverrideSource === "default") {
    return null;
  }
  const direct = readStoredOverrideFromEntry(params.sessionEntry, "session");
  if (direct) {
    return direct;
  }
  const parentKey = resolveParentSessionKeyCandidate(params);
  if (!parentKey) {
    return null;
  }
  const parentEntry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  if (hasSessionActiveAutoModelFallback(parentEntry)) {
    return null;
  }
  return readStoredOverrideFromEntry(parentEntry, "parent");
}

/** Preserve the shipped SDK's normalized view while retaining stored-input provenance. */
export function resolveStoredModelOverride(
  params: StoredModelOverrideReadParams & {
    defaultProvider: string;
    allowPluginNormalization?: boolean;
  },
): StoredModelOverride | null {
  const stored = readStoredModelOverride(params);
  if (!stored) {
    return null;
  }
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: stored.provider,
    overrideModel: stored.model,
    overrideRouteResolution: stored.routeResolution,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  return ref ? { ...ref, source: stored.source, routeResolution: stored.routeResolution } : null;
}
