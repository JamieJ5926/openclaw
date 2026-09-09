import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerTelemetryCli } from "./telemetry-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    getRuntimeConfig: vi.fn(),
    transformConfigFileWithRetry: vi.fn(),
    buildTelemetryPayload: vi.fn(),
    buildTelemetryUserAgent: vi.fn(),
    resolveTelemetryStatus: vi.fn(),
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
}));
vi.mock("../infra/telemetry.js", () => ({
  buildTelemetryPayload: mocks.buildTelemetryPayload,
  buildTelemetryUserAgent: mocks.buildTelemetryUserAgent,
  resolveTelemetryStatus: mocks.resolveTelemetryStatus,
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));

const config: OpenClawConfig = {
  telemetry: {
    enabled: true,
    consentedAt: "2026-08-23T00:00:00.000Z",
    runtimeUtcOffsetEnabled: true,
    runtimeUtcOffsetConsentedAt: "2026-09-01T12:00:00.000Z",
  },
};
const payload = {
  schema: 1,
  version: "2026.8.2",
  platform: "darwin-arm64",
  node: "26.0.1",
  surface: "gateway",
  features: {
    channels: ["discord", "telegram"],
    providerFamilies: ["anthropic", "openai"],
    pluginsEnabled: 7,
    sessionsLast24h: 14,
    runtimeUtcOffsetBucket: "pos_6_12",
  },
};

function createTelemetryProgram() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command()
    .name("openclaw")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stderr.push(text),
    });
  registerTelemetryCli(program);
  return { program, stdout, stderr };
}

async function runTelemetryCli(args: string[]): Promise<void> {
  const { program } = createTelemetryProgram();
  await program.parseAsync(["telemetry", ...args], { from: "user" });
}

describe("telemetry cli", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T12:00:00.000Z"));
    vi.clearAllMocks();
    mocks.transformConfigFileWithRetry.mockReset();
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.writeJson.mockImplementation(() => {});
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.buildTelemetryPayload.mockReturnValue(payload);
    mocks.buildTelemetryUserAgent.mockReturnValue(
      "openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)",
    );
    mocks.resolveTelemetryStatus.mockReturnValue({
      enabled: true,
      reason: "enabled",
      endpoint: "https://telemetry.openclaw.ai/api/latest-version",
      lastPingAt: Date.parse("2026-08-22T12:00:00.000Z"),
      runtimeUtcOffset: { optedIn: true, active: true },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints exactly the canonical payload when feature statistics are enabled", async () => {
    await runTelemetryCli(["show"]);

    expect(mocks.buildTelemetryPayload).toHaveBeenCalledWith(config, { surface: "gateway" });
    expect(mocks.runtimeLogs).toContain(JSON.stringify(payload));
    expect(mocks.runtimeLogs).toContain("Feature stats: enabled");
    expect(mocks.runtimeLogs).toContain("Runtime UTC-offset opt-in: enabled");
    expect(mocks.runtimeLogs).toContain("Runtime UTC-offset sharing: active");
    expect(mocks.runtimeLogs).toContain("Last ping: 2026-08-22T12:00:00.000Z");
    expect(mocks.runtimeLogs).toContain(
      "Request: POST https://telemetry.openclaw.ai/api/latest-version",
    );
  });

  it("reports the same state and canonical payload as one JSON document", async () => {
    await runTelemetryCli(["show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      {
        featureStatsEnabled: true,
        runtimeUtcOffset: { optedIn: true, active: true },
        reason: "enabled",
        endpoint: "https://telemetry.openclaw.ai/api/latest-version",
        lastPingAt: "2026-08-22T12:00:00.000Z",
        request: {
          method: "POST",
          userAgent: "openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)",
          payload,
        },
      },
      0,
    );
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "never-asked", label: "consent has not been requested", method: "GET" },
    { reason: "config-disabled", label: "disabled in configuration", method: "GET" },
    { reason: "do-not-track", label: "disabled by DO_NOT_TRACK", method: "GET" },
    { reason: "update-disabled", label: "update checks are disabled", method: null },
    {
      reason: "automated-environment",
      label: "disabled in an automated environment (CI is set)",
      method: null,
    },
  ])("reports the same request in JSON and text for $reason", async ({ reason, label, method }) => {
    const endpoint = "https://telemetry.openclaw.ai/api/latest-version";
    const userAgent = "openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)";
    mocks.resolveTelemetryStatus.mockReturnValue({
      enabled: false,
      reason,
      endpoint,
      runtimeUtcOffset: { optedIn: true, active: false },
    });

    await runTelemetryCli(["show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      {
        featureStatsEnabled: false,
        runtimeUtcOffset: { optedIn: true, active: false },
        reason,
        endpoint,
        lastPingAt: null,
        request: method ? { method, userAgent } : null,
      },
      0,
    );
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    await runTelemetryCli(["show"]);

    expect(mocks.buildTelemetryPayload).not.toHaveBeenCalled();
    expect(mocks.runtimeLogs).toEqual([
      "Feature stats: disabled",
      `Reason: ${label}`,
      "Runtime UTC-offset opt-in: enabled",
      "Runtime UTC-offset sharing: inactive",
      `Endpoint: ${endpoint}`,
      "Last ping: never",
      ...(method
        ? [`Request: ${method} ${endpoint}`, `User-Agent: ${userAgent}`]
        : [`Request: none (${label})`]),
    ]);
  });

  it.each([
    { command: "on", enabled: true },
    { command: "off", enabled: false },
  ])(
    "records operator consent when turning feature statistics $command",
    async ({ command, enabled }) => {
      const originalConfig: OpenClawConfig = {
        update: { checkOnStart: false },
        telemetry: {
          enabled: !enabled,
          consentedAt: "2025-01-01T00:00:00.000Z",
          runtimeUtcOffsetEnabled: true,
          runtimeUtcOffsetConsentedAt: "2026-09-01T12:00:00.000Z",
        },
      };
      mocks.transformConfigFileWithRetry.mockImplementationOnce(
        async (options: {
          transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig };
        }) => options.transform(originalConfig),
      );

      await runTelemetryCli([command]);

      const result = await mocks.transformConfigFileWithRetry.mock.results[0]?.value;
      expect(result.nextConfig).toMatchObject({
        update: { checkOnStart: false },
        telemetry: {
          enabled,
          consentedAt: "2026-09-09T12:00:00.000Z",
          runtimeUtcOffsetEnabled: true,
          runtimeUtcOffsetConsentedAt: "2026-09-01T12:00:00.000Z",
        },
      });
      expect(mocks.runtimeLogs).toContain(
        `Anonymous feature stats ${enabled ? "enabled" : "disabled"}.`,
      );
    },
  );

  it("keeps UTC-offset consent independent and cannot restore it with ordinary feature toggles", async () => {
    let stored: OpenClawConfig = {
      update: { checkOnStart: false },
      telemetry: { enabled: false, consentedAt: "2026-08-23T00:00:00.000Z" },
    };
    mocks.transformConfigFileWithRetry.mockImplementation(
      async (options: {
        transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig };
      }) => {
        const result = options.transform(stored);
        stored = result.nextConfig;
        return result;
      },
    );

    await runTelemetryCli(["utc-offset", "on"]);
    expect(stored).toEqual({
      update: { checkOnStart: false },
      telemetry: {
        enabled: false,
        consentedAt: "2026-08-23T00:00:00.000Z",
        runtimeUtcOffsetEnabled: true,
        runtimeUtcOffsetConsentedAt: "2026-09-09T12:00:00.000Z",
      },
    });

    await runTelemetryCli(["utc-offset", "off"]);
    expect(stored.telemetry).toEqual({
      enabled: false,
      consentedAt: "2026-08-23T00:00:00.000Z",
      runtimeUtcOffsetEnabled: false,
    });
    await runTelemetryCli(["on"]);
    await runTelemetryCli(["off"]);
    await runTelemetryCli(["on"]);
    expect(stored.telemetry).toEqual({
      enabled: true,
      consentedAt: "2026-09-09T12:00:00.000Z",
      runtimeUtcOffsetEnabled: false,
    });

    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    await runTelemetryCli(["utc-offset", "on"]);
    expect(stored.telemetry).toEqual({
      enabled: true,
      consentedAt: "2026-09-09T12:00:00.000Z",
      runtimeUtcOffsetEnabled: true,
      runtimeUtcOffsetConsentedAt: "2026-09-10T12:00:00.000Z",
    });
  });

  it.each([
    {
      args: [],
      usage: "telemetry [options] [command]",
      description: "Inspect and manage anonymous usage telemetry",
    },
    {
      args: ["utc-offset"],
      usage: "telemetry utc-offset [options] [command]",
      description: "Manage separate consent to runtime UTC-offset buckets",
    },
  ])("prints parent help for $usage without a subcommand", async ({ args, usage, description }) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const { program, stdout, stderr } = createTelemetryProgram();

    try {
      let exitCode: number;
      try {
        await program.parseAsync(["telemetry", ...args], { from: "user" });
        exitCode = process.exitCode ?? 0;
      } catch (error) {
        if (!(error instanceof CommanderError) || error.code !== "commander.help") {
          throw error;
        }
        exitCode = error.exitCode;
      }

      expect(exitCode).toEqual(0);
      expect(stdout.join("")).toContain(`Usage: openclaw ${usage}`);
      expect(stdout.join("")).toContain(description);
      expect(stderr).toEqual([]);
      expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    { name: "explicit help", args: ["--help"], usage: "telemetry [options] [command]" },
    { name: "implicit help", args: ["help"], usage: "telemetry [options] [command]" },
    { name: "nested help", args: ["help", "show"], usage: "telemetry show [options]" },
    {
      name: "offset help",
      args: ["utc-offset", "--help"],
      usage: "telemetry utc-offset [options] [command]",
    },
    {
      name: "offset command help",
      args: ["utc-offset", "help", "on"],
      usage: "telemetry utc-offset on [options]",
    },
  ])("preserves $name without reading or changing telemetry", async ({ args, usage }) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const { program, stdout, stderr } = createTelemetryProgram();
    try {
      await expect(
        program.parseAsync(["telemetry", ...args], { from: "user" }),
      ).rejects.toMatchObject({ exitCode: 0 });
      expect(stdout.join("")).toContain(`Usage: openclaw ${usage}`);
      expect(stderr).toEqual([]);
      expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
