// Covers `models auth logout`: store removal, config-reference cleanup, and refusals.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  listProfilesForProvider: vi.fn(() => [] as string[]),
  removeAuthProfilesAcrossOwnerStores: vi.fn(async () => true),
  loadModelsConfig: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfiles:
    mocks.ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider: mocks.listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: (_cfg: OpenClawConfig, rawAgentId?: string) => ({
      agentId: rawAgentId ?? "main",
      agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
    }),
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: mocks.confirm }),
}));

const { modelsAuthLogoutCommand, removeModelAuthCredentials } = await import("./auth-logout.js");

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (message: string) => {
      logs.push(message);
    },
    error: () => {},
  } as unknown as RuntimeEnv & { logs: string[] };
}

function storeWith(profileIds: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [
        profileId,
        { type: "oauth" as const, provider: profileId.split(":")[0] ?? "openai", access: "tok" },
      ]),
    ),
  } as unknown as AuthProfileStore;
}

/** Runs the config mutator captured by the mocked updateConfig. */
function applyCapturedConfigUpdate(cfg: OpenClawConfig): OpenClawConfig {
  const mutator = mocks.updateConfig.mock.calls[0]?.[0] as
    | ((current: OpenClawConfig) => OpenClawConfig)
    | undefined;
  if (!mutator) {
    throw new Error("expected updateConfig to be called");
  }
  return mutator(cfg);
}

async function withStdinIsTty<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  try {
    return await run();
  } finally {
    if (hadOwnIsTTY && previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else {
      Reflect.deleteProperty(stdin, "isTTY");
    }
  }
}

describe("models auth logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeAuthProfilesAcrossOwnerStores.mockResolvedValue(true);
    mocks.confirm.mockResolvedValue(true);
    mocks.listProfilesForProvider.mockReturnValue([]);
    mocks.updateConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      storeWith(["openai:manual"]),
    );
  });

  it("removes the profile from the selected agent store", async () => {
    const runtime = createRuntime();
    await modelsAuthLogoutCommand({ profileId: "openai:manual", agent: "poe", yes: true }, runtime);

    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-poe",
      cfg: {},
      profileIds: ["openai:manual"],
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("poe", runtime);
    expect(runtime.logs).toContain("Removed auth profile: openai:manual (openai/oauth)");
    expect(runtime.logs.some((line) => line.includes("No auth profiles remain for openai"))).toBe(
      true,
    );
    // Nothing in config referenced the profile, so config stays untouched.
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("drops config auth.profiles and auth.order references to the removed profile", async () => {
    const cfg = {
      auth: {
        profiles: {
          "openai:manual": { provider: "openai", mode: "oauth" },
          "openai:backup": { provider: "openai", mode: "api_key" },
          "anthropic:manual": { provider: "anthropic", mode: "oauth" },
        },
        order: {
          openai: ["openai:manual", "openai:backup"],
          anthropic: ["anthropic:manual"],
        },
      },
    } as unknown as OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
    expect(applyCapturedConfigUpdate(cfg).auth).toEqual({
      profiles: {
        "openai:backup": { provider: "openai", mode: "api_key" },
        "anthropic:manual": { provider: "anthropic", mode: "oauth" },
      },
      order: {
        openai: ["openai:backup"],
        anthropic: ["anthropic:manual"],
      },
    });
    expect(mocks.logConfigUpdated).toHaveBeenCalledTimes(1);
  });

  it("deletes an emptied provider order but keeps an authored empty one", async () => {
    const cfg = {
      auth: {
        profiles: { "openai:manual": { provider: "openai", mode: "oauth" } },
        order: { openai: ["openai:manual"], anthropic: [] },
      },
    } as unknown as OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    // `anthropic: []` is an authored "select no profiles" instruction for an
    // unrelated provider; only the order this removal emptied may go.
    expect(applyCapturedConfigUpdate(cfg).auth).toEqual({
      profiles: {},
      order: { anthropic: [] },
    });
  });

  it("removes the config reference before deleting the credential", async () => {
    const cfg = {
      auth: { profiles: { "openai:manual": { provider: "openai", mode: "oauth" } } },
    } as unknown as OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    const calls: string[] = [];
    mocks.updateConfig.mockImplementation(async () => {
      calls.push("config");
      return cfg;
    });
    mocks.removeAuthProfilesAcrossOwnerStores.mockImplementation(async () => {
      calls.push("store");
      return true;
    });

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    expect(calls).toEqual(["config", "store"]);
  });

  it("removes a config-bound API key while keeping the connection and its sibling", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "other/current" } },
      models: {
        providers: {
          sample: { baseUrl: "https://provider.example/v1", models: [], apiKey: "sample:bound" },
        },
      },
      auth: {
        profiles: {
          "sample:bound": { provider: "sample", mode: "api_key" },
          "sample:backup": { provider: "sample", mode: "api_key" },
        },
        order: { sample: ["sample:bound", "sample:backup"], untouched: [] },
      },
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "sample:bound": { type: "api_key", provider: "sample", key: "bound-key" },
        "sample:backup": { type: "api_key", provider: "sample", key: "backup-key" },
      },
    };
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(store);
    await modelsAuthLogoutCommand({ profileId: "sample:bound", yes: true }, createRuntime());
    const next = applyCapturedConfigUpdate(cfg);
    expect(next.models?.providers?.sample).toEqual({
      baseUrl: "https://provider.example/v1",
      models: [],
    });
    expect(next.auth?.order).toEqual({ sample: ["sample:backup"], untouched: [] });
    expect(next.agents?.defaults?.model).toBe("other/current");
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
      cfg,
      agentDir: "/tmp/agent-main",
      profileIds: ["sample:bound"],
    });
  });

  it("keeps a credential when its config references cannot be cleared", async () => {
    const cfg: OpenClawConfig = {
      auth: { profiles: { "openai:manual": { provider: "openai", mode: "oauth" } } },
    };
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    mocks.updateConfig.mockRejectedValueOnce(new Error("Config is read-only"));
    await expect(
      modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime()),
    ).rejects.toThrow("Config is read-only");
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });

  it("clears an inline key while preserving SecretRef and unrelated connection settings", async () => {
    const ref = { source: "env", provider: "default", id: "SAMPLE_API_KEY" } as const;
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          sample: { baseUrl: "https://provider.example/v1", models: [], apiKey: "inline-key" },
          other: { baseUrl: "https://other.example/v1", models: [], apiKey: ref },
        },
      },
    };
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {},
    });
    await removeModelAuthCredentials({
      cfg,
      agentDir: "/tmp/agent-main",
      profileIds: [],
      apiKeyProvider: "sample",
    });
    const next = applyCapturedConfigUpdate(cfg);
    expect(next.models?.providers?.sample?.apiKey).toBeUndefined();
    expect(next.models?.providers?.sample?.baseUrl).toBe("https://provider.example/v1");
    expect(next.models?.providers?.other?.apiKey).toEqual(ref);
  });

  it.each([
    {
      label: "unknown profile id",
      profileId: "openai:missing",
      cfg: {} as OpenClawConfig,
      expected: 'Auth profile "openai:missing" not found for agent "main"',
    },
    {
      label: "blank profile id",
      profileId: "  ",
      cfg: {} as OpenClawConfig,
      expected: "Missing profile id",
    },
  ])("refuses removal for $label", async ({ profileId, cfg, expected }) => {
    mocks.loadModelsConfig.mockResolvedValue(cfg);

    await expect(
      modelsAuthLogoutCommand({ profileId, yes: true }, createRuntime()),
    ).rejects.toThrow(expected);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });

  it("fails when the auth store update does not complete", async () => {
    mocks.removeAuthProfilesAcrossOwnerStores.mockResolvedValue(false);

    await expect(
      modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime()),
    ).rejects.toThrow("Saved credentials could not be removed");
  });

  it("keeps the profile when an interactive confirmation is declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    await withStdinIsTty(true, async () => {
      const runtime = createRuntime();
      await modelsAuthLogoutCommand({ profileId: "openai:manual" }, runtime);
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
      expect(runtime.logs).toContain("Cancelled.");
    });
  });

  it("refuses to remove without --yes when stdin is not a TTY", async () => {
    await withStdinIsTty(false, async () => {
      await expect(
        modelsAuthLogoutCommand({ profileId: "openai:manual" }, createRuntime()),
      ).rejects.toThrow("Pass --yes to remove it non-interactively.");
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    });
  });
});
