/** Shared mocked write boundary for config handler tests. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const configWriteMocks = vi.hoisted(() => ({
  commitGatewayConfigWrite: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
  };
});

// This suite owns config patch/merge behavior, while plugin validation is covered by
// config.plugin-validation.test.ts and validation.channel-metadata.test.ts.
vi.mock("../../config/validation.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  );
  return {
    ...actual,
    validateConfigObjectRawWithPlugins: vi.fn((config: OpenClawConfig) => ({
      ok: true,
      config,
      warnings: [],
    })),
    validateConfigObjectWithPlugins: vi.fn((config: OpenClawConfig) => ({
      ok: true,
      config,
      warnings: [],
    })),
  };
});

// Secret materialization has dedicated runtime suites; keep these handler tests on
// their config-write boundary instead of loading every provider and plugin artifact.
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    config,
  })),
}));

vi.mock("./config-write-flow.js", async () => {
  const actual =
    await vi.importActual<typeof import("./config-write-flow.js")>("./config-write-flow.js");
  return {
    ...actual,
    commitGatewayConfigWrite: configWriteMocks.commitGatewayConfigWrite,
    resolveGatewayConfigRestartWriteResult: vi.fn(async () => ({
      payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
      sentinelPersisted: false,
      restart: undefined,
    })),
  };
});

const { loadGatewayRuntimeConfigSchemaMock } = vi.hoisted(() => ({
  loadGatewayRuntimeConfigSchemaMock: vi.fn(() => ({
    schema: { type: "object" },
    uiHints: undefined as Record<string, { advanced?: boolean }> | undefined,
    version: "test-schema",
  })),
}));

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
}));

export { configWriteMocks, loadGatewayRuntimeConfigSchemaMock };

export const configTestState = {
  config: {} as OpenClawConfig,
  hash: "base-hash",
  nextHash: 1,
  pluginMetadata: undefined as PluginMetadataSnapshot | undefined,
};

export function currentWriteSnapshot() {
  const result = createConfigWriteSnapshot(configTestState.config);
  result.snapshot.hash = configTestState.hash;
  result.snapshot.raw = JSON.stringify(configTestState.config);
  if (configTestState.pluginMetadata) {
    result.writeOptions = {
      basePluginMetadataSnapshot: configTestState.pluginMetadata,
    } as never;
  }
  return result;
}

export async function invokeConfigPatch(args: {
  raw: unknown;
  baseHash?: string;
  replacePaths?: string[];
}) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
      ...(args.replacePaths ? { replacePaths: args.replacePaths } : {}),
    },
  });
  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(harness.options);
  return harness;
}

export function installConfigHandlerTestHooks() {
  beforeEach(() => {
    configTestState.config = {};
    configTestState.hash = "base-hash";
    configTestState.nextHash = 1;
    configTestState.pluginMetadata = undefined;
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () =>
      currentWriteSnapshot(),
    );
    configWriteMocks.commitGatewayConfigWrite.mockImplementation(
      async ({
        snapshot,
        nextConfig,
      }: {
        snapshot: { hash?: string };
        nextConfig: OpenClawConfig;
      }) => {
        if (snapshot.hash !== configTestState.hash) {
          throw new ConfigMutationConflictError("config changed since last load");
        }
        configTestState.config = nextConfig;
        configTestState.hash = `next-hash-${configTestState.nextHash}`;
        configTestState.nextHash += 1;
        return {
          path: "/tmp/openclaw.json",
          config: configTestState.config,
          hash: configTestState.hash,
          queueFollowUp: vi.fn(),
        };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    clearConfigSchemaResponseCacheForTests();
    resetPluginRuntimeStateForTest();
    vi.clearAllMocks();
  });
}
