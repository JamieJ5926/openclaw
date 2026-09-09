import type { Command } from "commander";
import { getRuntimeConfig, transformConfigFileWithRetry } from "../config/config.js";
import {
  buildTelemetryPayload,
  buildTelemetryUserAgent,
  resolveTelemetryStatus,
} from "../infra/telemetry.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

const TELEMETRY_REASON_LABELS = {
  enabled: "enabled in configuration",
  "automated-environment": "disabled in an automated environment (CI is set)",
  "do-not-track": "disabled by DO_NOT_TRACK",
  "config-disabled": "disabled in configuration",
  "never-asked": "consent has not been requested",
  "update-disabled": "update checks are disabled",
} satisfies Record<ReturnType<typeof resolveTelemetryStatus>["reason"], string>;

async function showTelemetry(options: { json?: boolean }): Promise<void> {
  const config = getRuntimeConfig({ skipPluginValidation: true });
  const telemetry = resolveTelemetryStatus(config);
  const request =
    telemetry.reason === "update-disabled" || telemetry.reason === "automated-environment"
      ? null
      : {
          method: telemetry.enabled ? "POST" : "GET",
          userAgent: buildTelemetryUserAgent("gateway"),
          ...(telemetry.enabled
            ? { payload: buildTelemetryPayload(config, { surface: "gateway" }) }
            : {}),
        };

  if (options.json) {
    defaultRuntime.writeJson(
      {
        featureStatsEnabled: telemetry.enabled,
        runtimeUtcOffset: telemetry.runtimeUtcOffset,
        reason: telemetry.reason,
        endpoint: telemetry.endpoint,
        lastPingAt: telemetry.lastPingAt ? new Date(telemetry.lastPingAt).toISOString() : null,
        request,
      },
      0,
    );
    return;
  }

  defaultRuntime.log(`Feature stats: ${telemetry.enabled ? "enabled" : "disabled"}`);
  defaultRuntime.log(`Reason: ${TELEMETRY_REASON_LABELS[telemetry.reason]}`);
  defaultRuntime.log(
    `Runtime UTC-offset opt-in: ${telemetry.runtimeUtcOffset.optedIn ? "enabled" : "disabled"}`,
  );
  defaultRuntime.log(
    `Runtime UTC-offset sharing: ${telemetry.runtimeUtcOffset.active ? "active" : "inactive"}`,
  );
  defaultRuntime.log(`Endpoint: ${telemetry.endpoint}`);
  defaultRuntime.log(
    `Last ping: ${telemetry.lastPingAt ? new Date(telemetry.lastPingAt).toISOString() : "never"}`,
  );
  if (!request) {
    defaultRuntime.log(`Request: none (${TELEMETRY_REASON_LABELS[telemetry.reason]})`);
    return;
  }
  defaultRuntime.log(`Request: ${request.method} ${telemetry.endpoint}`);
  defaultRuntime.log(`User-Agent: ${request.userAgent}`);
  if (request.payload) {
    defaultRuntime.log("Payload:");
    defaultRuntime.log(JSON.stringify(request.payload));
  }
}

async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  await transformConfigFileWithRetry({
    transform: (config) => ({
      nextConfig: {
        ...config,
        telemetry: {
          ...config.telemetry,
          enabled,
          consentedAt: new Date().toISOString(),
        },
      },
    }),
  });
  defaultRuntime.log(`Anonymous feature stats ${enabled ? "enabled" : "disabled"}.`);
}

async function setRuntimeUtcOffsetEnabled(enabled: boolean): Promise<void> {
  await transformConfigFileWithRetry({
    transform: (config) => {
      const telemetry = { ...config.telemetry, runtimeUtcOffsetEnabled: enabled };
      if (enabled) {
        telemetry.runtimeUtcOffsetConsentedAt = new Date().toISOString();
      } else {
        delete telemetry.runtimeUtcOffsetConsentedAt;
      }
      return { nextConfig: { ...config, telemetry } };
    },
  });
  defaultRuntime.log(`Runtime UTC-offset opt-in ${enabled ? "enabled" : "disabled"}.`);
}

export function registerTelemetryCli(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Inspect and manage anonymous usage telemetry");
  const utcOffset = telemetry
    .command("utc-offset")
    .description("Manage separate consent to runtime UTC-offset buckets");

  telemetry
    .command("show")
    .description("Preview the daily update request from this CLI process")
    .option("--json", "Print the request and payload as JSON")
    .action(async (options: { json?: boolean }) =>
      runCommandWithRuntime(defaultRuntime, () => showTelemetry(options)),
    );

  for (const [name, enabled] of Object.entries({ on: true, off: false })) {
    telemetry
      .command(name)
      .description(`${enabled ? "Enable" : "Disable"} anonymous feature statistics`)
      .action(() => runCommandWithRuntime(defaultRuntime, () => setTelemetryEnabled(enabled)));
    utcOffset
      .command(name)
      .description(`${enabled ? "Enable" : "Disable"} the separate runtime UTC-offset opt-in`)
      .action(() =>
        runCommandWithRuntime(defaultRuntime, () => setRuntimeUtcOffsetEnabled(enabled)),
      );
  }
  applyParentDefaultHelpAction(utcOffset.helpCommand(true));
  // Preserve the shipped help subcommand when adding a parent action.
  applyParentDefaultHelpAction(telemetry.helpCommand(true));
}
