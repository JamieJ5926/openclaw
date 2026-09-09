/** Tests for model identity preservation at Gateway config mutation boundaries. */
// Register shared mocks before loading config handlers.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  configTestState,
  configWriteMocks,
  currentWriteSnapshot,
  installConfigHandlerTestHooks,
  invokeConfigPatch,
} from "./config.handler.test-support.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

installConfigHandlerTestHooks();

describe("config.patch model input normalization", () => {
  it("uses write-snapshot policies to merge aliases while preserving authored model IDs", async () => {
    configTestState.pluginMetadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "myproxy-normalizer",
          modelIdNormalization: {
            providers: {
              myproxy: { aliases: { latest: "modern-model" }, prefixWhenBare: "vendor" },
            },
          },
        },
      ],
    });
    configTestState.config = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            models: [
              {
                id: "vendor/modern-model",
                name: "Before",
                contextWindow: 200_000,
                maxTokens: 8192,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
              },
            ],
          },
        },
      },
    };

    const sourceConfig = structuredClone(configTestState.config);
    expectDefined(sourceConfig.models?.providers?.myproxy?.models[0], "source model").id = "latest";
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementationOnce(async () => {
      const result = currentWriteSnapshot();
      result.snapshot.sourceConfig = sourceConfig;
      result.snapshot.resolved = sourceConfig;
      result.snapshot.parsed = sourceConfig;
      result.snapshot.raw = JSON.stringify(sourceConfig);
      return result;
    });

    const harness = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            myproxy: { models: [{ id: "vendor/modern-model", name: "After" }] },
          },
        },
      },
      baseHash: configTestState.hash,
    });

    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(configTestState.config.models?.providers?.myproxy?.models).toHaveLength(1);
    expect(configTestState.config.models?.providers?.myproxy?.models?.[0]).toMatchObject({
      id: "latest",
      name: "After",
    });
  });

  function aliasConfig(ids: string[]): OpenClawConfig {
    configTestState.pluginMetadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "myproxy-normalizer",
          modelIdNormalization: {
            providers: {
              myproxy: {
                aliases: {
                  latest: "middle",
                  current: "middle",
                  middle: "final",
                  future: "new-model",
                },
              },
            },
          },
        },
      ],
    });
    return {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            models: ids.map((id) => ({
              id,
              name: id,
              contextWindow: 200_000,
              maxTokens: 8192,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: false,
            })),
          },
        },
      },
    };
  }

  it.each(["config.set", "config.apply", "config.patch"] as const)(
    "%s preserves authored alias chains on unrelated writes",
    async (method) => {
      configTestState.config = aliasConfig(["latest", "middle"]);
      const harness = createConfigHandlerHarness({
        method,
        params: {
          raw: JSON.stringify({
            ...(method === "config.patch" ? {} : configTestState.config),
            gateway: { port: 18790 },
          }),
          baseHash: configTestState.hash,
        },
      });
      await expectDefined(configHandlers[method], "config write handler")(harness.options);
      expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      expect(configTestState.config.models?.providers?.myproxy?.models.map(({ id }) => id)).toEqual(
        ["latest", "middle"],
      );
    },
  );

  it("merges each alias-chain row once and preserves new submitted model IDs", async () => {
    configTestState.config = aliasConfig(["latest", "middle"]);
    const harness = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            myproxy: {
              models: [
                { id: "current", name: "First" },
                { id: "middle", name: "Second" },
                { id: "future", name: "Third" },
              ],
            },
          },
        },
      },
      baseHash: configTestState.hash,
    });
    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(
      configTestState.config.models?.providers?.myproxy?.models.map(({ id, name }) => ({
        id,
        name,
      })),
    ).toEqual([
      { id: "latest", name: "First" },
      { id: "middle", name: "Second" },
      { id: "future", name: "Third" },
    ]);
  });

  it.each([false, true])(
    "rejects equivalent model IDs (duplicates in source: %s)",
    async (duplicateSource) => {
      configTestState.config = aliasConfig(duplicateSource ? ["latest", "current"] : ["latest"]);
      const harness = await invokeConfigPatch({
        raw: {
          models: {
            providers: {
              myproxy: {
                models: (duplicateSource ? ["latest"] : ["latest", "current"]).map((id) => ({
                  id,
                  name: "Updated",
                })),
              },
            },
          },
        },
        baseHash: configTestState.hash,
      });
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("duplicate ID"),
        }),
      );
      expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    },
  );

  it("preserves submitted alias spellings in explicit model array replacements", async () => {
    configTestState.config = aliasConfig(["latest"]);
    const harness = await invokeConfigPatch({
      raw: aliasConfig(["current", "latest"]),
      baseHash: configTestState.hash,
      replacePaths: ["models.providers.myproxy.models"],
    });
    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(configTestState.config.models?.providers?.myproxy?.models.map(({ id }) => id)).toEqual([
      "current",
      "latest",
    ]);
  });

  it.each([
    { replacePaths: undefined, allowed: false },
    { replacePaths: ["models.providers.myproxy.models"], allowed: false },
    { replacePaths: ["models.providers.myproxy.models[].input"], allowed: true },
  ])(
    "guards nested array removal through model aliases: $replacePaths",
    async ({ replacePaths, allowed }) => {
      configTestState.config = aliasConfig(["latest"]);
      const harness = await invokeConfigPatch({
        raw: {
          models: { providers: { myproxy: { models: [{ id: "current", input: ["text"] }] } } },
        },
        baseHash: configTestState.hash,
        replacePaths,
      });
      if (allowed) {
        expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(configTestState.config.models?.providers?.myproxy?.models[0]).toMatchObject({
          id: "latest",
          input: ["text"],
        });
      } else {
        expect(harness.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining("models.providers.myproxy.models[].input"),
          }),
        );
        expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
      }
    },
  );

  it("normalizes model identities before map and ID-keyed array merges", async () => {
    const canonical = "google/gemini-3.1-pro-preview";
    configTestState.config = {
      agents: { defaults: { models: { [canonical]: { alias: "Gemini" } } } },
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemini-3.1-pro-preview",
                name: "Gemini before",
                contextWindow: 1_048_576,
                maxTokens: 65_536,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: true,
              },
            ],
          },
        },
      },
    };

    const harness = await invokeConfigPatch({
      raw: {
        agents: {
          defaults: { models: { "google/gemini-3-pro-preview": null } },
        },
        models: {
          providers: {
            google: {
              models: [{ id: "gemini-3-pro-preview", name: "Gemini after" }],
            },
          },
        },
      },
      baseHash: configTestState.hash,
    });

    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(configTestState.config.agents?.defaults?.models).toEqual({});
    expect(configTestState.config.models?.providers?.google?.models).toHaveLength(1);
    expect(configTestState.config.models?.providers?.google?.models?.[0]).toMatchObject({
      id: "gemini-3.1-pro-preview",
      name: "Gemini after",
    });
  });

  it("canonicalizes newly submitted nested model refs before persistence", async () => {
    configTestState.config = { gateway: { port: 18789 } };
    const retired = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";

    const harness = await invokeConfigPatch({
      raw: {
        agents: {
          defaults: {
            model: { primary: retired, fallbacks: [retired] },
            utilityModel: retired,
            imageModel: retired,
            voiceModel: retired,
            pdfModel: retired,
            mediaModels: {
              image: retired,
              video: { primary: retired, fallbacks: [retired] },
              music: retired,
            },
            heartbeat: { model: retired },
            subagents: { model: retired },
            compaction: { model: retired, memoryFlush: { model: retired } },
            models: { [retired]: { alias: "Gemini" } },
          },
          entries: {
            ops: {
              model: retired,
              utilityModel: retired,
              subagents: { model: retired },
              models: { [retired]: { alias: "Ops Gemini" } },
            },
          },
        },
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemini-3-pro-preview",
                  name: "Gemini 3 Pro",
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: true,
                },
              ],
            },
          },
        },
      },
      baseHash: configTestState.hash,
    });

    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(configTestState.config.agents?.defaults).toMatchObject({
      model: { primary: canonical, fallbacks: [canonical] },
      utilityModel: canonical,
      imageModel: canonical,
      voiceModel: canonical,
      pdfModel: canonical,
      mediaModels: {
        image: canonical,
        video: { primary: canonical, fallbacks: [canonical] },
        music: canonical,
      },
      heartbeat: { model: canonical },
      subagents: { model: canonical },
      compaction: { model: canonical, memoryFlush: { model: canonical } },
      models: { [canonical]: { alias: "Gemini" } },
    });
    expect(configTestState.config.agents?.entries?.ops).toMatchObject({
      model: canonical,
      utilityModel: canonical,
      subagents: { model: canonical },
      models: { [canonical]: { alias: "Ops Gemini" } },
    });
    expect(configTestState.config.models?.providers?.google?.models?.[0]?.id).toBe(
      "gemini-3.1-pro-preview",
    );
  });
});
