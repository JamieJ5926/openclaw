import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as pluginRuntime from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { useMockHttp } from "../test-utils/mock-http.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import {
  buildTelemetryPayload,
  checkTelemetryUpdate,
  resolveTelemetryStatus,
} from "./telemetry.js";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_URL = "https://telemetry.openclaw.ai/api/latest-version";
const TELEMETRY_STATE_KEY = "telemetry.updateCheck";
const mockHttp = useMockHttp();

function installPluginRegistry(...plugins: Parameters<typeof createPluginRecord>[0][]): void {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(...plugins.map((plugin) => createPluginRecord(plugin)));
  pluginRuntime.setActivePluginRegistry(registry);
}

function createFeatureConfig(enabled = true, runtimeUtcOffsetEnabled?: boolean): OpenClawConfig {
  return {
    telemetry: {
      enabled,
      ...(runtimeUtcOffsetEnabled === undefined ? {} : { runtimeUtcOffsetEnabled }),
    },
    auth: {
      profiles: {
        "anthropic:private-account": {
          provider: "anthropic",
          mode: "api_key",
          email: "private@example.invalid",
        },
      },
    },
    channels: {
      telegram: { enabled: true, botToken: "private-telegram-token" },
      discord: { enabled: true, token: "private-discord-token" },
      "acme-internal-crm": { enabled: true },
      slack: { enabled: false, botToken: "private-slack-token" },
      defaults: { groupPolicy: "allowlist" },
      modelByChannel: { telegram: { "private-account-id": "openai/private-model" } },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://private-provider.example.invalid/v1",
          apiKey: "private-provider-api-key",
          models: [],
        },
        anthropic: {
          baseUrl: "https://private-anthropic.example.invalid/v1",
          apiKey: "private-anthropic-api-key",
          models: [],
        },
        "acme-llm": {
          baseUrl: "https://private-llm.example.invalid/v1",
          models: [],
        },
      },
    },
    plugins: {
      entries: {
        telegram: { enabled: true },
        discord: { enabled: true },
        memory: { enabled: true },
        "acme-internal-crm": { enabled: true },
        "acme-internal-workflows": { enabled: true },
        disabled: { enabled: false },
      },
    },
    gateway: { auth: { mode: "token", token: "private-gateway-token" } },
  };
}

describe("anonymous telemetry", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-telemetry-",
      env: {
        CI: undefined,
        DO_NOT_TRACK: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_TELEMETRY_ENDPOINT: undefined,
        TZ: undefined,
      },
    });
    installPluginRegistry(
      { id: "telegram", origin: "bundled", channelIds: ["telegram"] },
      { id: "discord", origin: "bundled", channelIds: ["discord"] },
      { id: "memory", origin: "bundled" },
      { id: "acme-internal-crm", channelIds: ["acme-internal-crm"] },
      { id: "acme-internal-workflows" },
      { id: "disabled", origin: "bundled", enabled: false, status: "disabled" },
      { id: "load-error", origin: "bundled", status: "error" },
      { id: "deferred", origin: "bundled", imported: false },
    );
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it("builds deterministic feature facts without credentials, identities, paths, or hostnames", () => {
    const payload = buildTelemetryPayload(createFeatureConfig(), { surface: "gateway" });
    const serialized = JSON.stringify(payload);

    expect(payload).toEqual({
      schema: 1,
      version: expect.any(String),
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      surface: "gateway",
      features: {
        channels: ["discord", "telegram"],
        providerFamilies: ["anthropic", "openai"],
        plugins: ["discord", "memory", "telegram"],
        pluginsEnabled: 5,
        sessionsLast24h: expect.any(Number),
      },
    });
    expect(serialized).not.toMatch(
      /"(?:id|accountId|userId|machineId|installId|token|apiKey|secret|password|prompt|message|host|hostname|baseUrl|path|email|models)"\s*:/iu,
    );
    expect(serialized).not.toContain("private-");
    expect(serialized).not.toContain("acme-internal-crm");
    expect(serialized).not.toContain("acme-internal-workflows");
    expect(serialized).not.toContain("acme-llm");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain(testState.stateDir);
    expect(payload.features.sessionsLast24h).toBeGreaterThanOrEqual(0);
  });

  it("counts loaded default plugins instead of unloaded config entries and accepts official provider families", () => {
    installPluginRegistry(
      { id: "whatsapp", origin: "bundled", channelIds: ["whatsapp"] },
      { id: "diagnostics-otel", origin: "bundled" },
    );
    const payload = buildTelemetryPayload(
      {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/private-model",
              fallbacks: ["openai/private-fallback", "cohere/private-official-model"],
            },
          },
          entries: {
            researcher: { model: "google/private-research-model" },
          },
        },
        channels: { whatsapp: { allowFrom: ["+15555550123"] } },
        plugins: { entries: { "never-loaded": { enabled: true } } },
      },
      { surface: "gateway" },
    );

    expect(payload.features).toMatchObject({
      channels: ["whatsapp"],
      providerFamilies: ["anthropic", "cohere", "google", "openai"],
      plugins: ["diagnostics-otel", "whatsapp"],
      pluginsEnabled: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("private-");
    expect(JSON.stringify(payload)).not.toContain("+15555550123");
  });

  it("classifies configured channels by their loaded plugin owner", () => {
    installPluginRegistry(
      { id: "public-channel-owner", origin: "bundled", channelIds: ["public-alias"] },
      { id: "acme-internal-crm", channelIds: ["telegram"] },
    );

    const payload = buildTelemetryPayload(
      { channels: { "public-alias": { enabled: true }, telegram: { enabled: true } } },
      { surface: "gateway" },
    );

    expect(payload.features.channels).toEqual(["public-alias"]);
    expect(payload.features.plugins).toEqual(["public-channel-owner"]);
    expect(payload.features.pluginsEnabled).toBe(2);
    expect(JSON.stringify(payload)).not.toContain("acme-internal-crm");
  });

  it.each(
    (["provider map", "auth profile", "model reference"] as const).flatMap((source) =>
      [
        { provider: "OpenAI", expected: ["openai"] },
        { provider: " OpenAI ", expected: ["openai"] },
        { provider: " Open AI ", expected: [] },
        { provider: " Acme-Private ", expected: [] },
      ].map(({ provider, expected }) => ({ source, provider, expected })),
    ),
  )(
    "reports loaded $source provider $provider as $expected",
    async ({ source, provider, expected }) => {
      const input: OpenClawConfig = { plugins: { enabled: false } };
      if (source === "provider map") {
        input.models = {
          providers: { [provider]: { baseUrl: "https://provider.example.invalid/v1", models: [] } },
        };
      } else if (source === "auth profile") {
        input.auth = { profiles: { configured: { provider, mode: "api_key" } } };
      } else {
        input.agents = { defaults: { model: `${provider}/gpt-4o` } };
      }
      await testState.writeConfig(input);
      const config = createConfigIO({
        configPath: testState.configPath,
        env: { OPENCLAW_STATE_DIR: testState.stateDir },
        homedir: () => testState.home,
        observe: false,
      }).loadConfig();

      // The real loader accepts these spellings without canonicalizing the provider identity.
      if (source === "provider map") {
        expect(Object.keys(config.models?.providers ?? {})).toEqual([provider]);
      } else if (source === "auth profile") {
        expect(config.auth?.profiles?.configured?.provider).toBe(provider);
      }
      expect(
        buildTelemetryPayload(config, { surface: "gateway" }).features.providerFamilies,
      ).toEqual(expected);
    },
  );

  it("deduplicates canonical provider families across config maps, auth, and model references", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          OpenAI: { baseUrl: "https://provider.example.invalid/v1", models: [] },
          " openai ": { baseUrl: "https://provider.example.invalid/v1", models: [] },
        },
      },
      auth: { profiles: { configured: { provider: " OPENAI ", mode: "api_key" } } },
      agents: { defaults: { model: "OpenAI/gpt-4o" } },
    };

    expect(buildTelemetryPayload(config, { surface: "gateway" }).features.providerFamilies).toEqual(
      ["openai"],
    );
  });

  it("uses manifest-owned plugin activation when a CLI has no active runtime registry", () => {
    const activeRegistry = vi.spyOn(pluginRuntime, "getActivePluginRegistry").mockReturnValue(null);
    try {
      const payload = buildTelemetryPayload(
        {
          channels: { telegram: { enabled: true } },
          plugins: { allow: ["telegram"] },
        },
        { surface: "cli" },
      );

      expect(payload.features.channels).toEqual(["telegram"]);
      expect(payload.features.plugins).toContain("telegram");
      expect(payload.features.pluginsEnabled).toBe(payload.features.plugins.length);
    } finally {
      activeRegistry.mockRestore();
    }
  });

  it("counts only session creation events from the previous 24 hours", async () => {
    const { recordSessionStateEvent } = await import("../sessions/session-state-events.js");
    const now = Date.now();
    for (const event of [
      { sessionKey: "recent", kind: "created" as const, occurredAt: now - 1000 },
      { sessionKey: "older", kind: "created" as const, occurredAt: now - DAY_MS - 1000 },
      { sessionKey: "other", kind: "run_completed" as const, occurredAt: now - 1000 },
    ]) {
      recordSessionStateEvent(
        {
          ...event,
          agentId: "main",
          actorType: "system",
          summary: "test session event",
        },
        { now: event.occurredAt },
      );
    }

    expect(buildTelemetryPayload({}, { surface: "gateway" }).features.sessionsLast24h).toBe(1);
  });

  it("sends at most one request per 24 hours and reuses the persisted update result", async () => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24", note: "A newer release is available." } },
    });
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.25" } },
    });
    const options = { surface: "gateway" as const, fetchImpl: globalThis.fetch };

    const first = await checkTelemetryUpdate({}, { ...options, nowMs: NOW });
    const cached = await checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS - 1 });

    expect(first).toEqual({ version: "2026.8.24", note: "A newer release is available." });
    expect(cached).toEqual(first);
    expect(mockHttp.requests()).toHaveLength(1);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW,
      latestVersion: "2026.8.24",
      note: "A newer release is available.",
    });

    const refreshed = await checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS + 1 });

    expect(refreshed).toEqual({ version: "2026.8.25" });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW + DAY_MS + 1,
      latestVersion: "2026.8.25",
    });
  });

  it("retains a successful response through write failures and recovers without extending its throttle", async () => {
    const { db } = openOpenClawStateDatabase();
    db.exec("PRAGMA query_only = ON");
    const update = { version: "2026.8.24", note: "A newer release is available." };
    mockHttp.intercept({ url: TELEMETRY_URL, reply: { json: update } });
    mockHttp.intercept({ url: TELEMETRY_URL, reply: { json: { version: "2026.8.25" } } });
    const options = { surface: "gateway" as const, fetchImpl: globalThis.fetch };

    const first = await checkTelemetryUpdate({}, { ...options, nowMs: NOW });
    const retained = await checkTelemetryUpdate({}, { ...options, nowMs: NOW + 120_000 });

    expect({ first, retained, requests: mockHttp.requests().length }).toEqual({
      first: update,
      retained: update,
      requests: 1,
    });
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();

    db.exec("PRAGMA query_only = OFF");
    await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW + 240_000 })).resolves.toEqual(
      update,
    );
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW,
      latestVersion: update.version,
      note: update.note,
    });
    await expect(
      checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS - 1 }),
    ).resolves.toEqual(update);
    expect(mockHttp.requests()).toHaveLength(1);

    await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS })).resolves.toEqual({
      version: "2026.8.25",
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW + DAY_MS,
      latestVersion: "2026.8.25",
    });
  });

  it.each(["endpoint", "state directory", "implicit home"] as const)(
    "keeps an unpersisted response isolated when the %s changes",
    async (scope) => {
      const { db } = openOpenClawStateDatabase();
      db.exec("PRAGMA query_only = ON");
      const options = { surface: "gateway" as const, fetchImpl: globalThis.fetch };
      mockHttp.intercept({
        url: TELEMETRY_URL,
        reply: { json: { version: "2026.8.24" } },
      });
      await checkTelemetryUpdate({}, { ...options, nowMs: NOW });

      let endpoint = TELEMETRY_URL;
      if (scope === "endpoint") {
        endpoint = "https://telemetry.example.invalid/api/latest-version";
        setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", endpoint);
      } else if (scope === "state directory") {
        setTestEnvValue("OPENCLAW_STATE_DIR", testState.path("alternate-state"));
      } else {
        deleteTestEnvValue("OPENCLAW_STATE_DIR");
        setTestEnvValue("OPENCLAW_HOME", testState.path("alternate-home"));
      }
      mockHttp.intercept({ url: endpoint, reply: { json: { version: "2026.8.25" } } });

      await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW + 120_000 })).resolves.toEqual(
        { version: "2026.8.25" },
      );
      expect(mockHttp.requests()).toHaveLength(2);
      testState.applyEnv();

      await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW + 240_000 })).resolves.toEqual(
        { version: "2026.8.24" },
      );
      expect(mockHttp.requests()).toHaveLength(2);
    },
  );

  it("shares the retained success across equivalent resolved state paths", async () => {
    const { db } = openOpenClawStateDatabase();
    db.exec("PRAGMA query_only = ON");
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24" } },
    });
    const options = { surface: "gateway" as const, fetchImpl: globalThis.fetch };
    await checkTelemetryUpdate({}, { ...options, nowMs: NOW });
    setTestEnvValue("OPENCLAW_STATE_DIR", `${testState.stateDir}/.`);

    await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW + 120_000 })).resolves.toEqual({
      version: "2026.8.24",
    });
    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("keeps the request's state destination when the environment changes during HTTP", async () => {
    const { db } = openOpenClawStateDatabase();
    db.exec("PRAGMA query_only = ON");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      setTestEnvValue("OPENCLAW_STATE_DIR", testState.path("alternate-state"));
      return Response.json({ version: "2026.8.24" });
    });
    const options = { surface: "gateway" as const, fetchImpl };

    await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW })).resolves.toEqual({
      version: "2026.8.24",
    });
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();
    testState.applyEnv();
    db.exec("PRAGMA query_only = OFF");

    await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW + 120_000 })).resolves.toEqual({
      version: "2026.8.24",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW,
      latestVersion: "2026.8.24",
    });
  });

  it("does not replace a newer persisted success with a retained older response", async () => {
    const { db } = openOpenClawStateDatabase();
    db.exec("PRAGMA query_only = ON");
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24" } },
    });
    const options = { surface: "gateway" as const, fetchImpl: globalThis.fetch };
    await checkTelemetryUpdate({}, { ...options, nowMs: NOW });
    db.exec("PRAGMA query_only = OFF");
    const newerState = { lastPingAt: NOW + 60_000, latestVersion: "2026.8.25" };
    writeConfigMachineState(TELEMETRY_STATE_KEY, newerState);

    await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW + 120_000 })).resolves.toEqual({
      version: "2026.8.25",
    });
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual(newerState);
    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("preserves a newer durable success written while the request was awaiting HTTP", async () => {
    const newerState = { lastPingAt: NOW + 60_000, latestVersion: "2026.8.25" };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      writeConfigMachineState(TELEMETRY_STATE_KEY, newerState);
      return Response.json({ version: "2026.8.24" });
    });

    await expect(
      checkTelemetryUpdate({}, { surface: "gateway", fetchImpl, nowMs: NOW }),
    ).resolves.toEqual({ version: newerState.latestVersion });

    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual(newerState);
  });

  it("uses a newer transaction-selected success instead of sending at the pending timestamp's expiry", async () => {
    const { db } = openOpenClawStateDatabase();
    db.exec("PRAGMA query_only = ON");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: "2026.8.24" }))
      .mockResolvedValueOnce(Response.json({ version: "2026.8.26" }));
    const options = { surface: "gateway" as const, fetchImpl };
    await checkTelemetryUpdate({}, { ...options, nowMs: NOW });
    db.exec("PRAGMA query_only = OFF");

    const newerState = { lastPingAt: NOW + DAY_MS - 60_000, latestVersion: "2026.8.25" };
    const originalRead = readConfigMachineState;
    const read = vi
      .spyOn(await import("../state/config-machine-state.js"), "readConfigMachineState")
      .mockImplementationOnce((...args) => {
        const snapshot = originalRead(...args);
        writeConfigMachineState(TELEMETRY_STATE_KEY, newerState);
        return snapshot;
      });
    try {
      const result = await checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS });
      expect({ result, requests: fetchImpl.mock.calls.length }).toEqual({
        result: { version: newerState.latestVersion },
        requests: 1,
      });
      expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual(newerState);
    } finally {
      read.mockRestore();
    }
  });

  it.each([
    { name: "never opted in", config: {} satisfies OpenClawConfig },
    { name: "explicitly opted out", config: createFeatureConfig(false) },
    {
      name: "only offset buckets opted in",
      config: { telemetry: { runtimeUtcOffsetEnabled: true } },
    },
    {
      name: "feature stats revoked with offset opt-in retained",
      config: createFeatureConfig(false, true),
    },
  ])("sends only an anonymous GET when $name", async ({ config }) => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "GET",
      requestHeaders: {
        "user-agent": `openclaw/${VERSION} (${process.platform}; node/${process.versions.node}; ${process.arch}; gateway)`,
      },
      reply: { json: { version: "2026.8.24" } },
    });

    await expect(
      checkTelemetryUpdate(config, {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests()).toHaveLength(1);
    expect(mockHttp.requests()[0]?.body ?? null).toBeNull();
    expect(mockHttp.requests()[0]?.headers).not.toHaveProperty("content-type");
  });

  it.each([
    { name: "existing feature consent", telemetry: { enabled: true } },
    {
      name: "explicit offset opt-out",
      telemetry: {
        enabled: true,
        runtimeUtcOffsetEnabled: false,
        runtimeUtcOffsetConsentedAt: "2026-09-01T12:00:00.000Z",
      },
    },
    {
      name: "an offset timestamp without its opt-in flag",
      telemetry: { enabled: true, runtimeUtcOffsetConsentedAt: "2026-09-01T12:00:00.000Z" },
    },
  ])("omits the UTC-offset bucket for $name", async ({ telemetry }) => {
    const config = { ...createFeatureConfig(), telemetry };
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "POST",
      reply: { json: { version: "2026.8.24" } },
    });

    await expect(
      checkTelemetryUpdate(config, { surface: "gateway", fetchImpl: globalThis.fetch, nowMs: NOW }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests()).toHaveLength(1);
    expect(JSON.parse(mockHttp.requests()[0]?.body ?? "{}").features).not.toHaveProperty(
      "runtimeUtcOffsetBucket",
    );
    expect(resolveTelemetryStatus(config).runtimeUtcOffset).toEqual({
      optedIn: false,
      active: false,
    });
  });

  it.each([
    { timezoneOffset: 720, expected: "neg_12_6" },
    { timezoneOffset: 420, expected: "neg_12_6" },
    { timezoneOffset: 360.25, expected: "neg_12_6" },
    { timezoneOffset: 360, expected: "neg_6_0" },
    { timezoneOffset: 359.75, expected: "neg_6_0" },
    { timezoneOffset: 0.25, expected: "neg_6_0" },
    { timezoneOffset: 0, expected: "utc_0" },
    { timezoneOffset: -0, expected: "utc_0" },
    { timezoneOffset: -0.25, expected: "pos_0_6" },
    { timezoneOffset: -345, expected: "pos_0_6" },
    { timezoneOffset: -359.75, expected: "pos_0_6" },
    { timezoneOffset: -360, expected: "pos_6_12" },
    { timezoneOffset: -360.25, expected: "pos_6_12" },
    { timezoneOffset: -705, expected: "pos_6_12" },
    { timezoneOffset: -719.75, expected: "pos_6_12" },
    { timezoneOffset: -720, expected: "pos_12_14" },
    { timezoneOffset: -765, expected: "pos_12_14" },
    { timezoneOffset: -840, expected: "pos_12_14" },
    { timezoneOffset: 720.25, expected: "unknown" },
    { timezoneOffset: -840.25, expected: "unknown" },
    { timezoneOffset: NaN, expected: "unknown" },
    { timezoneOffset: Infinity, expected: "unknown" },
    { timezoneOffset: -Infinity, expected: "unknown" },
  ])(
    "serializes UTC-offset bucket $expected for native offset $timezoneOffset",
    async ({ timezoneOffset, expected }) => {
      const config = createFeatureConfig(true, true);
      config.telemetry = {
        ...config.telemetry,
        consentedAt: "2026-08-23T12:00:00.000Z",
        runtimeUtcOffsetConsentedAt: "2026-09-01T12:00:00.000Z",
      };
      const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(timezoneOffset);
      mockHttp.intercept({
        url: TELEMETRY_URL,
        method: "POST",
        reply: { json: { version: "2026.8.24" } },
      });
      try {
        await expect(
          checkTelemetryUpdate(config, {
            surface: "gateway",
            fetchImpl: globalThis.fetch,
            nowMs: NOW,
          }),
        ).resolves.toEqual({ version: "2026.8.24" });
        expect(mockHttp.requests()).toHaveLength(1);
        const serialized = mockHttp.requests()[0]?.body ?? "{}";
        expect(JSON.parse(serialized).features.runtimeUtcOffsetBucket).toBe(expected);
        expect(serialized).not.toMatch(
          /"(?:runtimeUtcOffset|runtimeUtcOffsetEnabled|runtimeUtcOffsetConsentedAt|consentedAt|timezone|timeZone|tz|location|latitude|longitude|deviceModel|role|id|installId|machineId|timestamp)"\s*:/u,
        );
        expect(serialized).not.toContain("private-");
        expect(serialized).not.toContain("2026-09-01T12:00:00.000Z");
        expect(resolveTelemetryStatus(config).runtimeUtcOffset).toEqual({
          optedIn: true,
          active: true,
        });
      } finally {
        offset.mockRestore();
      }
    },
  );

  it.each(["invalid clock", "unavailable offset"] as const)(
    "still sends feature statistics with an unknown bucket for an %s",
    async (scenario) => {
      const clock =
        scenario === "invalid clock"
          ? vi.spyOn(Date, "now").mockReturnValue(NaN)
          : vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(() => {
              throw new Error("Timezone offset unavailable");
            });
      mockHttp.intercept({
        url: TELEMETRY_URL,
        method: "POST",
        reply: { json: { version: "2026.8.24" } },
      });
      try {
        await expect(
          checkTelemetryUpdate(createFeatureConfig(true, true), {
            surface: "gateway",
            fetchImpl: globalThis.fetch,
            nowMs: NOW,
          }),
        ).resolves.toEqual({ version: "2026.8.24" });
        expect(mockHttp.requests()).toHaveLength(1);
        expect(
          JSON.parse(mockHttp.requests()[0]?.body ?? "{}").features.runtimeUtcOffsetBucket,
        ).toBe("unknown");
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("uses the send-time runtime offset across a DST bucket boundary, not the preview or scheduling time", async () => {
    const config = createFeatureConfig(true, true);
    const winter = Date.parse("2026-01-15T12:00:00.000Z");
    const summer = Date.parse("2026-07-15T12:00:00.000Z");
    setTestEnvValue("TZ", "America/Denver");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(winter);
      expect(new Date().getTimezoneOffset()).toBe(420);
      expect(
        buildTelemetryPayload(config, { surface: "gateway" }).features.runtimeUtcOffsetBucket,
      ).toBe("neg_12_6");
      vi.setSystemTime(summer);
      expect(new Date().getTimezoneOffset()).toBe(360);
      mockHttp.intercept({
        url: TELEMETRY_URL,
        method: "POST",
        reply: { json: { version: "2026.8.24" } },
      });

      await expect(
        checkTelemetryUpdate(config, {
          surface: "gateway",
          fetchImpl: globalThis.fetch,
          nowMs: winter,
        }),
      ).resolves.toEqual({ version: "2026.8.24" });

      const serialized = mockHttp.requests()[0]?.body ?? "{}";
      expect(JSON.parse(serialized).features.runtimeUtcOffsetBucket).toBe("neg_6_0");
      expect(serialized).not.toContain("America/Denver");
      expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
        lastPingAt: winter,
        latestVersion: "2026.8.24",
      });
      await checkTelemetryUpdate(config, {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: winter + DAY_MS - 1,
      });
      expect(mockHttp.requests()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits a revoked UTC-offset opt-in on the next daily report without sending an extra request", async () => {
    const config = createFeatureConfig(true, true);
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "POST",
      reply: { json: { version: "2026.8.24" } },
      times: 2,
    });
    const options = { surface: "gateway" as const, fetchImpl: globalThis.fetch };
    await checkTelemetryUpdate(config, { ...options, nowMs: NOW });
    expect(JSON.parse(mockHttp.requests()[0]?.body ?? "{}").features).toHaveProperty(
      "runtimeUtcOffsetBucket",
    );
    config.telemetry = { ...config.telemetry, runtimeUtcOffsetEnabled: false };
    await checkTelemetryUpdate(config, { ...options, nowMs: NOW + 1 });
    expect(mockHttp.requests()).toHaveLength(1);

    await checkTelemetryUpdate(config, { ...options, nowMs: NOW + DAY_MS });

    expect(mockHttp.requests()).toHaveLength(2);
    expect(JSON.parse(mockHttp.requests()[1]?.body ?? "{}").features).not.toHaveProperty(
      "runtimeUtcOffsetBucket",
    );
  });

  it("POSTs exactly the canonical payload only after explicit feature-stats opt-in", async () => {
    const config = createFeatureConfig();
    const expectedBody = JSON.stringify(buildTelemetryPayload(config, { surface: "gateway" }));
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "POST",
      requestBody: expectedBody,
      requestHeaders: { "content-type": /^application\/json(?:\s*;.*)?$/u },
      reply: { json: { version: "2026.8.24" } },
    });

    await expect(
      checkTelemetryUpdate(config, {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it.each(["1", "true"])(
    "DO_NOT_TRACK=%s suppresses feature stats but keeps update checks",
    async (value) => {
      setTestEnvValue("DO_NOT_TRACK", value);
      mockHttp.intercept({
        url: TELEMETRY_URL,
        method: "GET",
        reply: { json: { version: "2026.8.24" } },
      });

      await expect(
        checkTelemetryUpdate(createFeatureConfig(true, true), {
          surface: "gateway",
          fetchImpl: globalThis.fetch,
          nowMs: NOW,
        }),
      ).resolves.toEqual({ version: "2026.8.24" });

      expect(mockHttp.requests()).toHaveLength(1);
      expect(mockHttp.requests()[0]?.body ?? null).toBeNull();
      expect(resolveTelemetryStatus(createFeatureConfig(true, true)).runtimeUtcOffset).toEqual({
        optedIn: true,
        active: false,
      });
      expect(
        buildTelemetryPayload(createFeatureConfig(true, true), { surface: "gateway" }).features,
      ).not.toHaveProperty("runtimeUtcOffsetBucket");
    },
  );

  it.each([
    { policy: "update.checkOnStart", envKey: undefined, reason: "update-disabled" },
    {
      policy: "OPENCLAW_NO_AUTO_UPDATE",
      envKey: "OPENCLAW_NO_AUTO_UPDATE",
      reason: "update-disabled",
    },
    { policy: "CI", envKey: "CI", reason: "automated-environment" },
    { policy: "OPENCLAW_NIX_MODE", envKey: "OPENCLAW_NIX_MODE", reason: "update-disabled" },
  ])(
    "never sends a request under $policy suppression, including offset opt-in",
    async ({ envKey, reason }) => {
      const config = createFeatureConfig(true, true);
      if (envKey) {
        setTestEnvValue(envKey, "1");
      } else {
        config.update = { checkOnStart: false };
      }
      await expect(
        checkTelemetryUpdate(config, {
          surface: "gateway",
          fetchImpl: globalThis.fetch,
          nowMs: NOW,
        }),
      ).resolves.toBeNull();

      expect(mockHttp.requests()).toHaveLength(0);
      expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();
      expect(resolveTelemetryStatus(config)).toMatchObject({
        enabled: false,
        reason,
        runtimeUtcOffset: { optedIn: true, active: false },
      });
      expect(buildTelemetryPayload(config, { surface: "gateway" }).features).not.toHaveProperty(
        "runtimeUtcOffsetBucket",
      );
    },
  );

  it("still reports from an automated environment when an endpoint is configured for it", async () => {
    const customEndpoint = "https://telemetry.example.invalid/api/latest-version";
    setTestEnvValue("CI", "true");
    setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", customEndpoint);
    mockHttp.intercept({ url: customEndpoint, reply: { json: { version: "2026.8.24" } } });

    await expect(
      checkTelemetryUpdate({}, { surface: "gateway", fetchImpl: globalThis.fetch, nowMs: NOW }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it.each([
    {
      name: "CI override",
      envKey: undefined,
      updateDisabled: false,
      method: "POST",
      reason: "enabled",
    },
    {
      name: "DO_NOT_TRACK",
      envKey: "DO_NOT_TRACK",
      updateDisabled: false,
      method: "GET",
      reason: "do-not-track",
    },
    {
      name: "startup update policy",
      envKey: undefined,
      updateDisabled: true,
      method: null,
      reason: "update-disabled",
    },
    {
      name: "environment update policy",
      envKey: "OPENCLAW_NO_AUTO_UPDATE",
      updateDisabled: false,
      method: null,
      reason: "update-disabled",
    },
    {
      name: "Nix policy",
      envKey: "OPENCLAW_NIX_MODE",
      updateDisabled: false,
      method: null,
      reason: "update-disabled",
    },
  ])(
    "keeps UTC-offset status, preview, and transport consistent under custom-endpoint $name",
    async ({ envKey, updateDisabled, method, reason }) => {
      const customEndpoint = "https://telemetry.example.invalid/api/latest-version";
      setTestEnvValue("CI", "true");
      setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", customEndpoint);
      if (envKey) {
        setTestEnvValue(envKey, "1");
      }
      const config = {
        ...createFeatureConfig(true, true),
        ...(updateDisabled ? { update: { checkOnStart: false } } : {}),
      };
      const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
      if (method) {
        mockHttp.intercept({
          url: customEndpoint,
          method,
          reply: { json: { version: "2026.8.24" } },
        });
      }
      try {
        expect(resolveTelemetryStatus(config)).toMatchObject({
          enabled: method === "POST",
          reason,
          runtimeUtcOffset: { optedIn: true, active: method === "POST" },
        });
        const preview = buildTelemetryPayload(config, { surface: "gateway" });
        if (method === "POST") {
          expect(preview.features.runtimeUtcOffsetBucket).toBe("utc_0");
        } else {
          expect(preview.features).not.toHaveProperty("runtimeUtcOffsetBucket");
        }

        const result = await checkTelemetryUpdate(config, {
          surface: "gateway",
          fetchImpl: globalThis.fetch,
          nowMs: NOW,
        });

        expect(result).toEqual(method ? { version: "2026.8.24" } : null);
        expect(mockHttp.requests()).toHaveLength(method ? 1 : 0);
        if (method === "POST") {
          expect(
            JSON.parse(mockHttp.requests()[0]?.body ?? "{}").features.runtimeUtcOffsetBucket,
          ).toBe("utc_0");
        } else if (method === "GET") {
          expect(mockHttp.requests()[0]?.body ?? null).toBeNull();
          expect(mockHttp.requests()[0]?.headers).not.toHaveProperty("content-type");
        }
      } finally {
        offset.mockRestore();
      }
    },
  );

  it("never accesses the network in a test environment without an injected fetch", async () => {
    await expect(
      checkTelemetryUpdate(createFeatureConfig(true, true), { surface: "gateway", nowMs: NOW }),
    ).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(0);
  });

  it("uses the configured telemetry endpoint instead of the public endpoint", async () => {
    const customEndpoint = "https://telemetry.example.invalid/api/latest-version";
    setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", customEndpoint);
    mockHttp.intercept({
      url: customEndpoint,
      reply: { json: { version: "2026.8.24" } },
    });

    await expect(
      checkTelemetryUpdate({}, { surface: "cli", fetchImpl: globalThis.fetch, nowMs: NOW }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests().map((request) => request.fullUrl)).toEqual([customEndpoint]);
  });

  it.each([
    { name: "HTTP errors", reply: { status: 503, json: { version: "2026.8.24" } } },
    { name: "a missing version", reply: { json: { note: "Missing required version" } } },
    { name: "a non-string version", reply: { json: { version: 20260824 } } },
    { name: "invalid JSON", reply: { body: "{invalid" } },
    { name: "network failures", reply: new Error("network unavailable") },
  ])("fails silently on $name without stamping a successful ping", async ({ reply }) => {
    mockHttp.intercept({ url: TELEMETRY_URL, reply });

    await expect(
      checkTelemetryUpdate({}, { surface: "gateway", fetchImpl: globalThis.fetch, nowMs: NOW }),
    ).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(1);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24" } },
    });
    await expect(
      checkTelemetryUpdate(
        {},
        {
          surface: "gateway",
          fetchImpl: globalThis.fetch,
          nowMs: NOW + 120_000,
        },
      ),
    ).resolves.toEqual({ version: "2026.8.24" });
    expect(mockHttp.requests()).toHaveLength(2);
  });

  it("bounds untrusted remote update notes before display or persistence", async () => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24", note: "x".repeat(800) } },
    });

    const result = await checkTelemetryUpdate(
      {},
      {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      },
    );
    const persisted = readConfigMachineState<{ note?: string }>(TELEMETRY_STATE_KEY);

    expect(result?.note).toHaveLength(500);
    expect(persisted?.note).toHaveLength(500);
  });

  it("bounds streamed update responses without replacing the cached result or successful ping", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('{"version":"2026.8.25","padding":"'),
      ...Array<Uint8Array>(32).fill(chunk),
      encoder.encode('"}'),
    ][Symbol.iterator]();
    let canceled = false;
    let enqueuedBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.next();
        if (next.done) {
          controller.close();
        } else {
          enqueuedBytes += next.value.byteLength;
          controller.enqueue(next.value);
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ version: "2026.8.24", padding: "x".repeat(chunk.length) }),
      )
      .mockResolvedValueOnce(new Response(body));
    const options = { surface: "gateway" as const, fetchImpl };

    await expect(checkTelemetryUpdate({}, { ...options, nowMs: NOW })).resolves.toEqual({
      version: "2026.8.24",
    });
    await expect(
      checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS + 1 }),
    ).resolves.toEqual({ version: "2026.8.24" });
    expect(canceled).toBe(true);
    expect(enqueuedBytes).toBeLessThan(32 * chunk.length);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW,
      latestVersion: "2026.8.24",
    });
    await expect(
      checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS + 30_001 }),
    ).resolves.toEqual({ version: "2026.8.24" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
