import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential, AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactSensitiveText } from "../../logging/redact.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  upsertAuthProfileWithLockOrThrow:
    vi.fn<
      typeof import("../../agents/auth-profiles/upsert-with-lock.js").upsertAuthProfileWithLockOrThrow
    >(),
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", async () => ({
  resolveAuthProfileOrder: (await import("../../agents/auth-profiles/order.js"))
    .resolveAuthProfileOrder,
  resolvePersistedAuthProfileOwnerAgentDir: ({ agentDir }: { agentDir: string }) => agentDir,
  ensureAuthProfileStoreWithoutExternalProfiles:
    mocks.ensureAuthProfileStoreWithoutExternalProfiles,
}));
vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  upsertAuthProfileWithLockOrThrow: mocks.upsertAuthProfileWithLockOrThrow,
}));
vi.mock("./shared.js", () => ({
  loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
  updateConfig: mocks.updateConfig,
}));

const { saveModelProviderApiKey } = await import("./auth-api-key.js");
const connection = { baseUrl: "https://provider.example/v1", models: [] };
const request = {
  provider: "sample",
  apiKey: "synthetic-new-key",
  agentDir: "/tmp/agent-writer",
};

describe("saveModelProviderApiKey", () => {
  let currentConfig: OpenClawConfig;
  let store: AuthProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    currentConfig = { agents: { defaults: { model: "other/current" } } };
    store = { version: 1, profiles: {} };
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockImplementation(() => store);
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.upsertAuthProfileWithLockOrThrow.mockImplementation(
      async ({ profileId, credential, validateCurrentCredential }) => {
        validateCurrentCredential?.(store.profiles[profileId]);
        store.profiles[profileId] = credential;
      },
    );
    mocks.updateConfig.mockImplementation(
      async (mutator: (config: OpenClawConfig) => OpenClawConfig) => {
        currentConfig = mutator(currentConfig);
        return currentConfig;
      },
    );
  });

  it("pins a configured connection to a non-secret profile reference without changing the default", async () => {
    currentConfig.models = {
      providers: { sample: { ...connection, apiKey: "previous-key" } },
    };

    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).resolves.toBe("sample:manual-api-key");

    expect(store.profiles).toEqual({
      "sample:manual-api-key": { type: "api_key", provider: "sample", key: "synthetic-new-key" },
    });
    expect(mocks.upsertAuthProfileWithLockOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: undefined }),
    );
    expect(currentConfig.models?.providers?.sample).toEqual({
      ...connection,
      apiKey: "sample:manual-api-key",
    });
    expect(currentConfig.auth?.profiles?.["sample:manual-api-key"]).toEqual({
      provider: "sample",
      mode: "api_key",
    });
    expect(currentConfig.agents?.defaults?.model).toBe("other/current");
  });

  it.each([
    { profileId: undefined, expectedProfileId: "sample:manual" },
    { profileId: "sample:work", expectedProfileId: "sample:work" },
  ])(
    "keeps CLI profile $expectedProfileId metadata-only",
    async ({ profileId, expectedProfileId }) => {
      currentConfig.models = {
        providers: { sample: { ...connection, apiKey: "configured-key" } },
      };

      await expect(saveModelProviderApiKey({ ...request, profileId })).resolves.toBe(
        expectedProfileId,
      );

      expect(Object.keys(store.profiles)).toEqual([expectedProfileId]);
      expect(store.profiles[expectedProfileId]).toEqual({
        type: "api_key",
        provider: "sample",
        key: "synthetic-new-key",
      });
      expect(currentConfig.auth?.profiles?.[expectedProfileId]).toEqual({
        provider: "sample",
        mode: "api_key",
      });
      expect(currentConfig.models?.providers?.sample?.apiKey).toBe("configured-key");
      expect(currentConfig.agents?.defaults?.model).toBe("other/current");
    },
  );

  it("replaces the ordered API-key profile without changing its stored order or sibling", async () => {
    store.profiles = {
      "sample:work": { type: "api_key", provider: "sample", key: "old-work" },
      "sample:backup": { type: "api_key", provider: "sample", key: "kept-backup" },
    };
    store.order = { sample: ["sample:work", "sample:backup"] };
    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).resolves.toBe("sample:work");
    expect(store.profiles["sample:work"]).toMatchObject({ key: "synthetic-new-key" });
    expect(store.profiles["sample:backup"]).toMatchObject({ key: "kept-backup" });
    expect(store.order).toEqual({ sample: ["sample:work", "sample:backup"] });
    expect(currentConfig.models).toBeUndefined();
  });

  it("saves an unconfigured provider without inventing connection settings", async () => {
    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).resolves.toBe("sample:manual-api-key");

    expect(store.profiles["sample:manual-api-key"]).toEqual({
      type: "api_key",
      provider: "sample",
      key: "synthetic-new-key",
    });
    expect(currentConfig.models).toBeUndefined();
  });

  it.each([
    { type: "api_key", provider: "other", key: "other-key" },
    { type: "oauth", provider: "sample", access: "access", refresh: "refresh", expires: 1_000_000 },
  ] satisfies AuthProfileCredential[])(
    "preserves an existing $type profile owned by $provider",
    async (credential) => {
      store.profiles["sample:manual-api-key"] = credential;

      await expect(
        saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
      ).rejects.toThrow("belongs to another sign-in");
      expect(store.profiles["sample:manual-api-key"]).toEqual(credential);
      expect(mocks.upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
      expect(mocks.updateConfig).not.toHaveBeenCalled();
    },
  );

  it("preserves a connection configured for OAuth", async () => {
    currentConfig.models = { providers: { sample: { ...connection, auth: "oauth" } } };

    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).rejects.toThrow("uses another sign-in method");
    expect(store.profiles).toEqual({});
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("does not bind a new global connection to a key saved in an agent-local store", async () => {
    mocks.updateConfig.mockImplementationOnce(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        currentConfig = {
          models: { providers: { sample: { ...connection, apiKey: "new-connection-key" } } },
        };
        currentConfig = mutator(currentConfig);
      },
    );
    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).rejects.toThrow("API key saved, but provider settings could not be applied");
    expect(currentConfig.models?.providers?.sample?.apiKey).toBe("new-connection-key");
    expect(store.profiles["sample:manual-api-key"]).toMatchObject({ key: "synthetic-new-key" });
  });

  it("reports a saved credential when its config write fails", async () => {
    mocks.updateConfig.mockRejectedValueOnce(new Error("Config is read-only"));

    await expect(saveModelProviderApiKey(request)).rejects.toThrow(
      "API key saved, but provider settings could not be applied: Config is read-only",
    );
    expect(store.profiles["sample:manual"]).toMatchObject({ key: "synthetic-new-key" });
    expect(currentConfig.auth).toBeUndefined();
  });

  it("normalizes pasted keys and redacts their saved value from logs", async () => {
    await saveModelProviderApiKey({ ...request, apiKey: "  ordinary-fixture\r\n-key-8304  " });
    expect(store.profiles["sample:manual"]).toMatchObject({ key: "ordinary-fixture-key-8304" });
    expect(redactSensitiveText("request failed for ordinary-fixture-key-8304")).not.toContain(
      "ordinary-fixture-key-8304",
    );
  });

  it("rejects a blank API key before changing credentials or config", async () => {
    await expect(saveModelProviderApiKey({ ...request, apiKey: "  " })).rejects.toThrow(
      "API key is required",
    );
    expect(store.profiles).toEqual({});
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "JWT token",
      value: ["eyJhbGciOiJub25l", "eyJzdWIiOiJmaXh0dXJlIn0", "signature123456"].join("."),
      error: "looks like token or OAuth material",
    },
    {
      label: "structured OAuth credential",
      value: '{"access_token":"fixture-token"}',
      error: "looks like token or OAuth material",
    },
    {
      label: "unrecognized value",
      value: "fixture-not-an-api-key",
      error: "does not look like an OpenAI API key",
    },
  ])("rejects $label before changing credentials or config", async ({ value, error }) => {
    await expect(
      saveModelProviderApiKey({ ...request, provider: "openai", apiKey: value }),
    ).rejects.toThrow(error);
    expect(store.profiles).toEqual({});
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});
