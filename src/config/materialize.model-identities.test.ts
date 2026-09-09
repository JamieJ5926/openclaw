import { describe, expect, it } from "vitest";
import { resolveEmbeddedCompactionTarget } from "../agents/embedded-agent-runner/compaction-runtime-context.js";
import { buildInlineProviderModels } from "../agents/embedded-agent-runner/model.inline-provider.js";
import { createConfiguredProviderCatalogModelIdNormalizer } from "../agents/model-ref-shared.js";
import {
  buildConfiguredModelCatalog,
  resolveConfiguredModelRef,
} from "../agents/model-selection-shared.js";
import { prepareConfiguredRuntimeModels } from "../agents/prepared-model-runtime.configured.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { normalizeSubmittedConfigModelRefs } from "./model-input-normalization.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "./types.js";

describe("materialized model identities", () => {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "fixture",
        providers: ["fixture"],
        modelIdNormalization: {
          providers: { fixture: { aliases: { latest: "middle", middle: "final" } } },
        },
        modelCatalog: {
          providers: {
            fixture: {
              models: [
                { id: "latest", contextWindow: 64_000 },
                { id: "final", contextWindow: 32_000 },
                { id: "middle", contextWindow: 128_000 },
              ],
            },
          },
        },
      },
    ],
  });
  const model = (id: string): ModelDefinitionConfig => ({
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4096,
  });

  it.each([
    { provider: "together/moonshotai", id: "Kimi-K2.5", expected: "Kimi-K2.5" },
    { provider: "google/google", id: "gemini-3-pro-preview", expected: "gemini-3-pro-preview" },
    { provider: "together", id: "moonshotai/Kimi-K2.5", expected: "moonshotai/Kimi-K2.6" },
    {
      provider: "custom",
      id: "custom/google/gemini-3-pro-preview",
      expected: "custom/google/gemini-3.1-pro-preview",
    },
  ])("keeps retirement scope for provider $provider", ({ provider, id, expected }) => {
    const config = normalizeSubmittedConfigModelRefs({
      models: {
        providers: {
          [provider]: { baseUrl: "https://fixture.invalid/v1", models: [model(id)] },
        },
      },
    });
    expect(config.models?.providers?.[provider]?.models[0]?.id).toBe(expected);
  });

  it("keeps case-distinct manifest metadata on its literal model", () => {
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture",
          providers: ["fixture"],
          modelCatalog: {
            providers: {
              fixture: {
                models: [
                  { id: "Reader", contextWindow: 32_000 },
                  { id: "reader", contextWindow: 64_000 },
                ],
              },
            },
          },
        },
      ],
    });
    const runtime = materializeRuntimeConfig(
      {
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid/v1",
              models: [model("Reader"), model("reader")],
            },
          },
        },
      },
      { env: {}, manifestRegistry: metadata.manifestRegistry },
    );
    expect(
      runtime.models?.providers?.fixture?.models.map(({ id, contextWindow }) => ({
        id,
        contextWindow,
      })),
    ).toEqual([
      { id: "Reader", contextWindow: 32_000 },
      { id: "reader", contextWindow: 64_000 },
    ]);
  });

  it.each(["fixture", "other"])(
    "keeps catalog and compaction identities with current provider %s",
    (currentProvider) => {
      const source: OpenClawConfig = {
        models: {
          providers: {
            fixture: {
              api: "openai-responses",
              baseUrl: "https://fixture.invalid/v1",
              models: [model("latest")],
            },
            other: {
              api: "openai-responses",
              baseUrl: "https://other.invalid/v1",
              models: [model("middle")],
            },
          },
        },
        agents: { defaults: { model: "fixture/latest", compaction: { model: "latest" } } },
      };
      const runtime = materializeRuntimeConfig(source, {
        env: {},
        manifestRegistry: snapshot.manifestRegistry,
      });
      const catalog = buildConfiguredModelCatalog({ cfg: runtime, manifestPlugins: snapshot });

      expect(catalog.map(({ provider, id }) => ({ provider, id }))).toEqual([
        { provider: "fixture", id: "middle" },
        { provider: "other", id: "middle" },
      ]);
      expect(catalog[0]?.contextWindow).toBe(128_000);
      expect(
        resolveConfiguredModelRef({
          cfg: runtime,
          defaultProvider: "other",
          defaultModel: "middle",
          manifestPlugins: snapshot,
        }),
      ).toEqual({ provider: "fixture", model: "middle" });
      expect(
        resolveEmbeddedCompactionTarget({
          config: runtime,
          provider: currentProvider,
          modelId: "middle",
          manifestPlugins: snapshot,
          allowPluginNormalization: false,
          resolvedModelCatalog: catalog,
        }),
      ).toMatchObject({ provider: "fixture", model: "middle" });
      expect(source.models?.providers?.fixture?.models?.[0]).toEqual(model("latest"));
      expect(runtime.models?.providers?.fixture?.models?.[0]?.id).toBe("latest");
    },
  );

  it.each(["latest", "middle"])("prepares inline %s without a static catalog row", (modelId) => {
    const source: OpenClawConfig = {
      models: {
        providers: {
          fixture: {
            api: "openai-responses",
            baseUrl: "https://fixture.invalid/v1",
            models: [model("latest")],
          },
        },
      },
    };
    const config = materializeRuntimeConfig(source, {
      env: {},
      manifestRegistry: snapshot.manifestRegistry,
    });
    const models = prepareConfiguredRuntimeModels({
      config,
      inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}),
      configuredModelRefs: [{ provider: "fixture", modelId }],
      metadataSnapshot: snapshot,
      providerStaticModels: [],
      resolveStaticCatalogModel: () => undefined,
      normalizeModelId: createConfiguredProviderCatalogModelIdNormalizer({
        manifestPlugins: snapshot,
      }),
    });
    expect(models).toMatchObject([
      {
        provider: "fixture",
        modelId,
        model: {
          provider: "fixture",
          id: "middle",
          api: "openai-responses",
          baseUrl: "https://fixture.invalid/v1",
        },
      },
    ]);
  });
});
