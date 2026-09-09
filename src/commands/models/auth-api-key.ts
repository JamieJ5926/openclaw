import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  normalizeManualAuthProvider,
  resolveDefaultTokenProfileId,
  validateOpenAICodexApiKeyInput,
} from "./auth-manual-input.js";
import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

/** Saves a manual key without changing model selection or connection settings. */
export async function saveModelProviderApiKey(params: {
  config?: OpenClawConfig;
  provider: string;
  apiKey: string;
  profileId?: string;
  agentDir: string;
  bindProviderConfig?: boolean;
}): Promise<string> {
  const provider = normalizeManualAuthProvider(params.provider);
  const key = normalizeSecretInput(params.apiKey);
  registerSecretValueForRedaction(key);
  const validationError = !key
    ? "API key is required"
    : provider === "openai"
      ? validateOpenAICodexApiKeyInput(key)
      : undefined;
  if (validationError) {
    throw new Error(validationError);
  }
  const config = params.config ?? (await loadValidConfigOrThrow());
  const validateCurrentCredential = (existing: AuthProfileCredential | undefined) => {
    if (
      existing &&
      (existing.type !== "api_key" || normalizeProviderId(existing.provider) !== provider)
    ) {
      throw new Error(
        "The API-key profile belongs to another sign-in. Manage that saved sign-in first.",
      );
    }
  };
  const configuredKey = (cfg: OpenClawConfig) => {
    const id = findNormalizedProviderKey(cfg.models?.providers, provider);
    const connection = id ? cfg.models?.providers?.[id] : undefined;
    if (connection?.auth && connection.auth !== "api-key") {
      throw new Error(
        "This connection uses another sign-in method. Use its sign-in option instead.",
      );
    }
    return id;
  };
  const connectionId = params.bindProviderConfig ? configuredKey(config) : undefined;
  const store = params.bindProviderConfig
    ? ensureAuthProfileStoreWithoutExternalProfiles(connectionId ? undefined : params.agentDir)
    : undefined;
  const replacementId =
    params.bindProviderConfig && !connectionId && store
      ? resolveAuthProfileOrder({ cfg: config, store, provider }).find((id) => {
          const credential = store.profiles[id];
          return credential?.type === "api_key" && !credential.keyRef;
        })
      : undefined;
  const profileId =
    params.profileId ??
    replacementId ??
    (params.bindProviderConfig
      ? provider + ":manual-api-key"
      : resolveDefaultTokenProfileId(provider));
  const agentDir = connectionId
    ? undefined
    : replacementId
      ? resolvePersistedAuthProfileOwnerAgentDir({ agentDir: params.agentDir, profileId })
      : params.agentDir;
  if (store) {
    validateCurrentCredential(store.profiles[profileId]);
  }
  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: { type: "api_key", provider, key },
    agentDir,
    ...(params.bindProviderConfig ? { validateCurrentCredential } : {}),
  });
  await updateConfig((current) => {
    const id = params.bindProviderConfig ? configuredKey(current) : undefined;
    if (id && agentDir !== undefined) {
      throw new Error(
        "The provider connection changed during the key update. Reopen the connection and save the key again.",
      );
    }
    const next = applyAuthProfileConfig(current, { profileId, provider, mode: "api_key" });
    if (!id || !next.models?.providers?.[id]) {
      return next;
    }
    return {
      ...next,
      models: {
        ...next.models,
        providers: {
          ...next.models.providers,
          [id]: { ...next.models.providers[id], apiKey: profileId },
        },
      },
    };
  }).catch((error: unknown) => {
    throw new Error(
      "API key saved, but provider settings could not be applied: " +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  });
  return profileId;
}
