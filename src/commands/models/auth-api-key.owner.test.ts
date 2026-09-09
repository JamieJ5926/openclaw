import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  resolvePersistedAuthProfileOwnerAgentDir,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth-provider-config.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { saveModelProviderApiKey } from "./auth-api-key.js";
import { removeModelAuthCredentials } from "./auth-logout.js";
import { loadValidConfigOrThrow } from "./shared.js";

let stateDir: string;
const agentDir = (id: string) => path.join(stateDir, "agents", id, "agent");
const providerConnection: ModelProviderConfig = {
  baseUrl: "http://127.0.0.1:9/v1",
  api: "openai-completions",
  auth: "api-key",
  models: [
    {
      id: "model",
      name: "Synthetic",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    },
  ],
};
function writeConfig(config: OpenClawConfig) {
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-api-key-owner-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  vi.stubEnv("OPENCLAW_OAUTH_DIR", undefined);
  writeConfig({});
});
afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("API-key storage and selection owners", () => {
  it("keeps a global provider binding resolvable by another agent after a key edit", async () => {
    writeConfig({
      models: { providers: { sample: { ...providerConnection, apiKey: "old-inline" } } },
    });
    const before = await loadValidConfigOrThrow();
    const profileId = await saveModelProviderApiKey({
      provider: "sample",
      apiKey: "new-shared-key",
      agentDir: agentDir("writer"),
      bindProviderConfig: true,
    });
    const config = await loadValidConfigOrThrow();
    expect(config.models?.providers?.sample).toEqual({
      ...before.models?.providers?.sample,
      apiKey: profileId,
    });
    expect(
      resolvePersistedAuthProfileOwnerAgentDir({ agentDir: agentDir("writer"), profileId }),
    ).toBeUndefined();
    const readerStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir("reader"));
    expect(
      resolveProviderEntryApiKeyProfileReference({
        cfg: config,
        provider: "sample",
        store: readerStore,
      }),
    ).toMatchObject({ kind: "profile", profileId });
    await expect(
      resolveApiKeyForProfile({
        cfg: config,
        store: readerStore,
        profileId,
        agentDir: agentDir("reader"),
      }),
    ).resolves.toMatchObject({ apiKey: "new-shared-key" });
  });

  it("replaces an ordered local key without creating an unused profile or changing its sibling", async () => {
    const writer = agentDir("writer");
    await upsertAuthProfileWithLockOrThrow({
      agentDir: writer,
      profileId: "sample:work",
      credential: { type: "api_key", provider: "sample", key: "old-work" },
    });
    await upsertAuthProfileWithLockOrThrow({
      agentDir: writer,
      profileId: "sample:backup",
      credential: { type: "api_key", provider: "sample", key: "kept-backup" },
    });
    await setAuthProfileOrder({
      agentDir: writer,
      provider: "sample",
      order: ["sample:work", "sample:backup"],
    });
    await expect(
      saveModelProviderApiKey({
        provider: "sample",
        apiKey: "replacement-work",
        agentDir: writer,
        bindProviderConfig: true,
      }),
    ).resolves.toBe("sample:work");
    const config = await loadValidConfigOrThrow();
    const store = ensureAuthProfileStoreWithoutExternalProfiles(writer);
    expect(resolveAuthProfileOrder({ cfg: config, store, provider: "sample" })).toEqual([
      "sample:work",
      "sample:backup",
    ]);
    await expect(
      resolveApiKeyForProfile({ cfg: config, store, profileId: "sample:work", agentDir: writer }),
    ).resolves.toMatchObject({ apiKey: "replacement-work" });
    expect(store.profiles["sample:backup"]).toMatchObject({ key: "kept-backup" });
    expect(store.profiles["sample:manual-api-key"]).toBeUndefined();
    expect(config.models).toBeUndefined();
  });

  it("preserves a stored external key reference and its provider binding when removing inline keys", async () => {
    const writer = agentDir("writer");
    const external = {
      type: "api_key" as const,
      provider: "sample",
      keyRef: { source: "env" as const, provider: "default", id: "AUTH_KEY_EXTERNAL_FIXTURE" },
    };
    await upsertAuthProfileWithLockOrThrow({
      agentDir: writer,
      profileId: "sample:external",
      credential: external,
    });
    await upsertAuthProfileWithLockOrThrow({
      agentDir: writer,
      profileId: "sample:inline",
      credential: { type: "api_key", provider: "sample", key: "removed-inline" },
    });
    writeConfig({
      models: { providers: { sample: { ...providerConnection, apiKey: "sample:external" } } },
    });
    const config = await loadValidConfigOrThrow();
    await removeModelAuthCredentials({
      cfg: config,
      agentDir: writer,
      profileIds: ["sample:inline"],
      apiKeyProvider: "sample",
    });
    const stored = loadPersistedAuthProfileStore(writer);
    expect(stored?.profiles["sample:external"]).toEqual(external);
    expect(stored?.profiles["sample:inline"]).toBeUndefined();
    expect((await loadValidConfigOrThrow()).models?.providers?.sample?.apiKey).toBe(
      "sample:external",
    );
  });
});
