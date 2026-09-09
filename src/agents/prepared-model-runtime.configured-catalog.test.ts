import type { ModelCatalogModel } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, assert, describe, expect, it } from "vitest";
import { materializeRuntimeConfig } from "../config/materialize.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { normalizeProviderMapKeys } from "./models-config.merge.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

describe("configured catalog registry composition", () => {
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each([
    { explicit: false, sourceProvider: "fixture" },
    { explicit: true, sourceProvider: "fixture" },
    { explicit: true, sourceProvider: "Fixture" },
  ])(
    "fills sparse alias rows from their final literal donors (explicit=$explicit, provider=$sourceProvider)",
    ({ explicit, sourceProvider }) => {
      const rows: ModelCatalogModel[] = [
        {
          id: "latest",
          name: "Latest",
          contextWindow: 64_000,
          reasoning: false,
          input: ["text"],
        },
        {
          id: "middle",
          name: "Middle",
          contextWindow: 128_000,
          reasoning: true,
          input: ["text", "image"],
        },
        {
          id: "final",
          name: "Final",
          contextWindow: 256_000,
          reasoning: false,
          input: ["text"],
        },
      ];
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
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
                  api: "openai-responses",
                  baseUrl: "https://fixture.invalid/v1",
                  models: rows,
                },
              },
            },
          },
        ],
      });
      const authoredMiddle: Partial<ModelDefinitionConfig> = explicit
        ? { contextWindow: 16_000, reasoning: false, input: ["text"] }
        : {};
      const validated = validateConfigObjectRaw({
        models: {
          providers: {
            [sourceProvider]: {
              api: "openai-responses",
              baseUrl: "https://fixture.invalid/v1",
              models: [
                { id: "latest", name: "Latest override" },
                { id: "middle", name: "Middle override", ...authoredMiddle },
              ],
            },
          },
        },
      });
      assert(validated.ok);
      const source = validated.config;
      const materialized = materializeRuntimeConfig(source, {
        env: {},
        manifestRegistry: metadataSnapshot.manifestRegistry,
      });
      const config = {
        ...materialized,
        models: {
          ...materialized.models,
          providers: normalizeProviderMapKeys(materialized.models?.providers),
        },
      };
      setRuntimeConfigSnapshot(config, source);
      const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
        config,
        includePluginCatalogs: false,
        pluginMetadataSnapshot: metadataSnapshot,
        modelsJsonContents: JSON.stringify({
          providers: {
            fixture: {
              api: "openai-responses",
              baseUrl: "https://fixture.invalid/v1",
              models: rows,
            },
          },
        }),
      });
      const { modelCatalog } = prepareCapturedRuntimeFacts({
        agentFacts: { input: { config }, configuredModelRefs: [] },
        workspaceFacts: {
          configuredCatalogEntries: buildConfiguredModelCatalog({
            cfg: config,
            manifestPlugins: metadataSnapshot,
          }),
          inlineProviderModels: [],
        },
        templateModelRegistry: registry,
        configuredRuntimeModels: [],
      });
      expect(modelCatalog.entries.find(({ id }) => id === "middle")).toMatchObject({
        contextWindow: explicit ? 16_000 : 128_000,
        reasoning: !explicit,
        input: explicit ? ["text"] : ["text", "image"],
      });
      expect(modelCatalog.entries.find(({ id }) => id === "latest")).toMatchObject({
        contextWindow: 64_000,
        reasoning: false,
        input: ["text"],
      });
      expect(modelCatalog.entries.find(({ id }) => id === "final")).toMatchObject({
        contextWindow: explicit ? 16_000 : 256_000,
        reasoning: false,
        input: ["text"],
      });
    },
  );
  it.each([
    { mode: "merge", expectedIds: ["selected", "retained-only"] },
    { mode: "replace", expectedIds: ["selected"] },
  ] as const)("keeps the $mode row set and configured fields", ({ mode, expectedIds }) => {
    const config: OpenClawConfig = {
      models: { mode },
    };
    const configured: ModelCatalogEntry = {
      provider: "donor-fixture",
      id: "selected",
      name: "Configured selected",
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      contextWindow: 32_000,
      reasoning: true,
      configuredReasoning: true,
      input: ["text"],
    };
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config,
      includePluginCatalogs: false,
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
      modelsJsonContents: JSON.stringify({
        providers: {
          "donor-fixture": {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            models: [
              {
                id: "selected",
                name: "Earlier selected",
                contextWindow: 64_000,
                maxTokens: 4096,
                reasoning: false,
                input: ["text", "image"],
              },
              {
                id: "retained-only",
                name: "Retained authored row",
                contextWindow: 48_000,
                maxTokens: 4096,
                reasoning: false,
                input: ["text", "image"],
              },
            ],
          },
        },
      }),
    });
    const agentFacts = {
      input: { config },
      configuredModelRefs: [{ provider: "donor-fixture", modelId: "selected" }],
    };
    const { modelCatalog } = prepareCapturedRuntimeFacts({
      agentFacts,
      workspaceFacts: { configuredCatalogEntries: [configured], inlineProviderModels: [] },
      templateModelRegistry: registry,
      configuredRuntimeModels: [],
    });

    expect(modelCatalog.entries.map((entry) => entry.id)).toEqual(expectedIds);
    expect(modelCatalog.entries[0]).toEqual(configured);
    expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
  });
});
