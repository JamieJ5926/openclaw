/** Tests for config gateway methods, writes, validation, and auth transitions. */
// Register shared mocks before loading config handlers.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  configTestState,
  configWriteMocks,
  installConfigHandlerTestHooks,
  invokeConfigPatch,
  loadGatewayRuntimeConfigSchemaMock,
} from "./config.handler.test-support.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const { execOpenPathMock } = vi.hoisted(() => ({ execOpenPathMock: vi.fn() }));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: execOpenPathMock };
});

function mockOpenPathError(error: Error) {
  execOpenPathMock.mockRejectedValue(error);
}

installConfigHandlerTestHooks();

function startConfigWrite(
  method: "config.patch" | "config.apply",
  args: { raw: unknown; baseHash?: string },
) {
  const harness = createConfigHandlerHarness({
    method,
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
    },
  });
  const handler = expectDefined(
    configHandlers[method],
    `configHandlers["${method}"] test invariant`,
  );
  return { harness, operation: handler(harness.options) };
}

async function invokeConfigSchema() {
  const harness = createConfigHandlerHarness({ method: "config.schema" });
  await expectDefined(
    configHandlers["config.schema"],
    'configHandlers["config.schema"] test invariant',
  )(harness.options);
  return harness;
}

async function invokeConfigOpenFile() {
  const harness = createConfigHandlerHarness({ method: "config.openFile" });
  await expectDefined(
    configHandlers["config.openFile"],
    'configHandlers["config.openFile"] test invariant',
  )(harness.options);
  return harness;
}

describe("config.patch effective change receipt", () => {
  it.each([
    { nextToken: "synthetic-old-token", expectedPaths: [] },
    {
      nextToken: "synthetic-new-token",
      expectedPaths: ["channels.matrix.accounts.sut.accessToken"],
    },
  ])(
    "reports persisted secret changes without values: $expectedPaths",
    async ({ nextToken, expectedPaths }) => {
      configTestState.config = {
        channels: { matrix: { accounts: { sut: { accessToken: "synthetic-old-token" } } } },
      };
      const { respond } = await invokeConfigPatch({
        raw: { channels: { matrix: { accounts: { sut: { accessToken: nextToken } } } } },
        baseHash: "base-hash",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ changedPaths: expectedPaths }),
        undefined,
      );
    },
  );
});

describe("config application settlement", () => {
  it.each(
    (["config.patch", "config.apply"] as const).flatMap((method) =>
      [
        { name: "hooks", config: { hooks: { enabled: true } } },
        {
          name: "new Gateway HTTP settings",
          config: { gateway: { http: { endpoints: { responses: { enabled: true } } } } },
        },
      ].map(({ name, config }) => ({ method, name, config })),
    ),
  )("waits for $method application of $name before acknowledging", async ({ method, config }) => {
    let settleApplication!: (status: "applied") => void;
    const application = new Promise<"applied">((resolve) => {
      settleApplication = resolve;
    });
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async (params) => ({
      path: "/tmp/openclaw.json",
      config,
      hash: "settled-hash",
      application: params.awaitRuntimeApplication ? application : undefined,
      queueFollowUp: vi.fn(),
    }));

    const { harness, operation } = startConfigWrite(method, {
      raw: config,
      baseHash: "base-hash",
    });
    await vi.waitFor(() =>
      expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce(),
    );

    expect(harness.respond).not.toHaveBeenCalled();

    settleApplication("applied");
    await operation;
    expect(harness.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
  });

  it.each(
    (["config.patch", "config.apply"] as const).flatMap((method) =>
      (["applied-restart-required", "restart-pending"] as const).map((outcome) => ({
        method,
        outcome,
      })),
    ),
  )(
    "reports $method $outcome without misrepresenting active config",
    async ({ method, outcome }) => {
      const queueFollowUp = vi.fn();
      configWriteMocks.commitGatewayConfigWrite.mockResolvedValueOnce({
        path: "/tmp/openclaw.json",
        config: { hooks: { enabled: true } },
        hash: "restart-hash",
        application: Promise.resolve(outcome),
        queueFollowUp,
      });

      const { harness, operation } = startConfigWrite(method, {
        raw: { hooks: { enabled: true } },
        baseHash: "base-hash",
      });
      await operation;

      const expectedMessage =
        outcome === "restart-pending" ? "accepted for restart" : "updated the active Gateway";
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining(expectedMessage),
        }),
      );
      const excludedMessages =
        outcome === "restart-pending"
          ? ["updated the active Gateway", "recovery restart", "reapply"]
          : ["was not applied", "reapply"];
      for (const excluded of excludedMessages) {
        expect(harness.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.not.stringContaining(excluded) }),
        );
      }
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("wait for the Gateway to restart"),
        }),
      );
      expect(harness.respond).toHaveBeenCalledOnce();
      expect(queueFollowUp).toHaveBeenCalledOnce();
    },
  );

  it.each(["superseded", "failed", "stopped", "unclaimed"] as const)(
    "reports a persisted write whose runtime application was %s",
    async (outcome) => {
      const queueFollowUp = vi.fn();
      configWriteMocks.commitGatewayConfigWrite.mockResolvedValueOnce({
        path: "/tmp/openclaw.json",
        config: { hooks: { enabled: true } },
        hash: `${outcome}-hash`,
        application: Promise.resolve(outcome),
        queueFollowUp,
      });

      const { harness, operation } = startConfigWrite("config.patch", {
        raw: { hooks: { enabled: true } },
        baseHash: "base-hash",
      });
      await operation;

      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("persisted but was not applied"),
        }),
      );
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("use config.apply") }),
      );
      expect(queueFollowUp).toHaveBeenCalledOnce();
    },
  );
});

describe("config.openFile", () => {
  it("opens the configured file without shell interpolation", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config $(touch pwned).json" }, async () => {
      execOpenPathMock.mockImplementation(async (command: { command: string; args: string[] }) => {
        expect(["open", "xdg-open", "powershell.exe"]).toContain(command.command);
        expect(command.args).toEqual(["/tmp/config $(touch pwned).json"]);
        return { stdout: "", stderr: "" };
      });

      const { respond } = await invokeConfigOpenFile();

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          path: "/tmp/config $(touch pwned).json",
        },
        undefined,
      );
    });
  });

  it("returns a detailed error and logs details when the opener fails", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
      mockOpenPathError(Object.assign(new Error("spawn xdg-open EACCES"), { code: "EACCES" }));

      const { respond, logGateway } = await invokeConfigOpenFile();

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: false,
          path: "/tmp/config.json",
          error: "Failed to open config file: spawn xdg-open EACCES",
        },
        undefined,
      );
      expect(logGateway.warn).toHaveBeenCalledWith(
        "config.openFile failed path=/tmp/config.json: spawn xdg-open EACCES",
      );
    });
  });

  it.runIf(process.platform === "linux")(
    "returns actionable headless environment error when xdg-open is missing",
    async () => {
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
        mockOpenPathError(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));

        const { respond, logGateway } = await invokeConfigOpenFile();

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            ok: false,
            path: "/tmp/config.json",
            error:
              "Cannot open file in headless environment. File path: /tmp/config.json. This environment appears to lack a graphical or terminal browser handler.",
          },
          undefined,
        );
        expect(logGateway.warn).toHaveBeenCalledWith(
          "config.openFile failed path=/tmp/config.json: spawn xdg-open ENOENT",
        );
      });
    },
  );

  it("does not split surrogate pairs when truncating the failed config path", async () => {
    const pathPrefix = `/tmp/${"a".repeat(111)}`;
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: `${pathPrefix}😀tail.json` }, async () => {
      mockOpenPathError(new Error("open failed"));

      const { logGateway } = await invokeConfigOpenFile();

      expect(logGateway.warn).toHaveBeenCalledWith(
        `config.openFile failed path=${pathPrefix}...: open failed`,
      );
    });
  });

  it("returns actionable headless environment error when xdg-open reports no method available", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
      mockOpenPathError(new Error("xdg-open: no method available for opening '/tmp/config.json'"));

      const { respond, logGateway } = await invokeConfigOpenFile();

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: false,
          path: "/tmp/config.json",
          error:
            "Cannot open file in headless environment. File path: /tmp/config.json. This environment appears to lack a graphical or terminal browser handler.",
        },
        undefined,
      );
      expect(logGateway.warn).toHaveBeenCalledWith(
        "config.openFile failed path=/tmp/config.json: xdg-open: no method available for opening '/tmp/config.json'",
      );
    });
  });
});

describe("config schema response cache", () => {
  it("returns resolved tier metadata through config.schema", async () => {
    loadGatewayRuntimeConfigSchemaMock.mockReturnValueOnce({
      schema: { type: "object" },
      uiHints: { "gateway.port": { advanced: false } },
      version: "test-schema",
    });
    const harness = await invokeConfigSchema();

    expect(harness.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        uiHints: { "gateway.port": { advanced: false } },
      }),
      undefined,
    );
  });

  it("reuses a recent schema build across burst config requests", async () => {
    await invokeConfigSchema();
    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after config writes change schema inputs", async () => {
    await invokeConfigSchema();
    const patch = await invokeConfigPatch({ raw: { ui: { prefs: { theme: "knot" } } } });

    expect(patch.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(1);

    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when the active plugin registry generation changes", async () => {
    await invokeConfigSchema();
    setActivePluginRegistry(createTestRegistry([]));
    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });
});

describe("config write source preparation", () => {
  it.each(["config.set", "config.apply", "config.patch"] as const)(
    "%s distinguishes literal nulls from omitted values at its write boundary",
    async (method) => {
      const source: OpenClawConfig = {
        gateway: { port: 18789 },
        agents: { defaults: { params: { temperature: 0.2, topP: 0.8 } } },
      };
      const runtime: OpenClawConfig = {
        ...source,
        agents: { defaults: { ...source.agents?.defaults, maxConcurrent: 4 } },
      };
      configTestState.config = source;
      configWriteMocks.readConfigFileSnapshotForWrite.mockImplementationOnce(async () => {
        const result = createConfigWriteSnapshot(source);
        result.snapshot.config = runtime;
        result.snapshot.runtimeConfig = runtime;
        return result;
      });
      const params = { temperature: null, nested: { value: null } };
      const harness = createConfigHandlerHarness({
        method,
        params: {
          raw: JSON.stringify(
            method === "config.patch"
              ? { agents: { defaults: { params: { temperature: null, topP: null } } } }
              : { ...runtime, agents: { defaults: { ...runtime.agents?.defaults, params } } },
          ),
          baseHash: configTestState.hash,
        },
      });

      await expectDefined(configHandlers[method], "config write handler")(harness.options);

      expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      expect(configTestState.config).toStrictEqual({
        ...source,
        agents: { defaults: { params: method === "config.patch" ? {} : params } },
      });
    },
  );

  it.each([
    ...(["config.set", "config.apply", "config.patch"] as const).flatMap((method) =>
      [false, true].map((authored) => ({
        method,
        authored,
        explicitDefault: false,
        changePort: true,
      })),
    ),
    ...[false, true].map((changePort) => ({
      method: "config.patch" as const,
      authored: false,
      explicitDefault: true,
      changePort,
    })),
  ])(
    "$method preserves source intent (authored: $authored, explicit default: $explicitDefault, port edit: $changePort)",
    async ({ method, authored, explicitDefault, changePort }) => {
      const source: OpenClawConfig = {
        gateway: { port: 18789 },
        ...(authored ? { agents: { defaults: { maxConcurrent: 4 } } } : {}),
      };
      const runtime: OpenClawConfig = {
        ...source,
        agents: { defaults: { maxConcurrent: 4 } },
      };
      configTestState.config = source;
      configWriteMocks.readConfigFileSnapshotForWrite.mockImplementationOnce(async () => {
        const result = createConfigWriteSnapshot(source);
        result.snapshot.config = runtime;
        result.snapshot.runtimeConfig = runtime;
        return result;
      });
      const harness = createConfigHandlerHarness({
        method,
        params: {
          raw: JSON.stringify({
            ...(method === "config.patch" ? {} : runtime),
            ...(explicitDefault ? { agents: runtime.agents } : {}),
            ...(changePort ? { gateway: { port: 18790 } } : {}),
          }),
          baseHash: configTestState.hash,
        },
      });

      await expectDefined(configHandlers[method], "config write handler")(harness.options);

      expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      expect(configTestState.config).toEqual({
        ...source,
        ...(explicitDefault ? { agents: runtime.agents } : {}),
        gateway: { port: changePort ? 18790 : 18789 },
      });
      expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
    },
  );
});

describe("config.patch hash-free ui.prefs LWW", () => {
  it("persists a ui.prefs-only patch and returns the committed hash", async () => {
    const { respond } = await invokeConfigPatch({ raw: { ui: { prefs: { theme: "knot" } } } });

    expect(configTestState.config.ui?.prefs?.theme).toBe("knot");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash-1" }),
      undefined,
    );
  });

  it("rejects a hash-free patch outside the LWW subtree", async () => {
    const { respond } = await invokeConfigPatch({ raw: { gateway: { port: 19_001 } } });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
  });

  it("rejects a mixed hash-free patch and names the guarded path", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: { port: 19_001 } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      // The operator must see which path needs the base hash; a bare
      // "hash required" with no path was a dead-end error.
      expect.objectContaining({
        message: expect.stringContaining("config base hash required for gateway.port"),
      }),
    );
    expect(configTestState.config).toEqual({});
  });

  it("rejects an empty-object structural change outside the LWW subtree", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: {} },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
  });

  it.each([
    { name: "ui.prefs deletion", raw: { ui: { prefs: null } } },
    { name: "ui deletion", raw: { ui: null } },
    { name: "scalar ui.prefs", raw: { ui: { prefs: "stale-container" } } },
  ])("rejects hash-free container operation: $name", async ({ raw }) => {
    configTestState.config = { ui: { prefs: { theme: "claw" } } };

    const { respond } = await invokeConfigPatch({ raw });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows a hash-free per-key null deletion below ui.prefs", async () => {
    configTestState.config = { ui: { prefs: { chatFollowUpMode: "queue", theme: "claw" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { chatFollowUpMode: null } } },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(configTestState.config.ui?.prefs).toEqual({ theme: "claw" });
  });

  it("keeps destructive array replacement explicit for hash-free patches", async () => {
    configTestState.config = { ui: { prefs: { sidebarEntries: ["route:usage", "route:tasks"] } } };

    const rejected = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
    });
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config.patch would remove entries from array path(s)"),
      }),
    );

    const accepted = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
      replacePaths: ["ui.prefs.sidebarEntries"],
    });
    expect(accepted.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(configTestState.config.ui?.prefs?.sidebarEntries).toEqual(["route:usage"]);
  });

  it("returns a noop for an unchanged hash-free patch", async () => {
    configTestState.config = { ui: { prefs: { theme: "knot" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ noop: true }), undefined);
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("preserves stale-hash rejection for strict patches", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
      baseHash: "stale-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config changed since last load"),
      }),
    );
  });

  it("surfaces a hash-free commit race without replaying stale intent", async () => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      configTestState.config = { ui: { prefs: { locale: "de" } } };
      configTestState.hash = "raced-hash";
      throw new ConfigMutationConflictError("config changed since last load");
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config changed since last load"),
      }),
    );
    expect(configTestState.config.ui?.prefs).toEqual({ locale: "de" });
  });

  it("advises retry only for retryable mutation conflicts", async () => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      throw new ConfigMutationConflictError("config path owned by another writer", {
        retryable: false,
      });
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      // A non-retryable conflict fails the retry too; advising it is a dead end.
      expect.objectContaining({
        message: "config path owned by another writer",
      }),
    );
  });
});

describe("config.patch ID-keyed arrays", () => {
  it("rejects duplicate IDs before applying an ID-merged array patch", async () => {
    configTestState.config = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.invalid",
            models: [{ id: "one", name: "One" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { respond } = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: {
              models: [
                { id: "one", name: "First" },
                { id: "one", name: "Second" },
              ],
            },
          },
        },
      },
      baseHash: "base-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("duplicate ID one") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows duplicate IDs for an explicit array replacement", async () => {
    configTestState.config = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.invalid",
            models: [{ id: "one", name: "One" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { respond } = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: {
              models: [
                { id: "one", name: "First" },
                { id: "one", name: "Second" },
              ],
            },
          },
        },
      },
      baseHash: "base-hash",
      replacePaths: ["models.providers.custom.models"],
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash-1" }),
      undefined,
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();

    const followUp = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: { models: [{ id: "one", name: "Third" }] },
          },
        },
      },
      baseHash: "next-hash-1",
    });

    expect(followUp.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("current config contains duplicate ID one"),
      }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
  });
});
