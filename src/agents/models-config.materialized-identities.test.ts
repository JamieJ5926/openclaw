import { assert, describe, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { planOpenClawModelsJsonWithDeps } from "./models-config.plan.test-support.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "./plugin-model-catalog.js";

function model(id: string, overrides: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    contextWindow: 8192,
    maxTokens: 2048,
    ...overrides,
  };
}

function provider(models: ModelDefinitionConfig[]): ModelProviderConfig {
  return {
    baseUrl: "https://models.example.test/v1",
    api: "openai-completions",
    apiKey: "MODEL_IDENTITY_FIXTURE_KEY",
    models,
  };
}

const aliasPolicy = { aliases: { latest: "middle", middle: "final" } };
const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "identity-fixture",
      providers: ["authored", "implicit", "generated", "manual"],
      modelIdNormalization: {
        providers: {
          authored: aliasPolicy,
          implicit: aliasPolicy,
          generated: aliasPolicy,
          manual: aliasPolicy,
        },
      },
    },
  ],
});

function context(cfg: OpenClawConfig) {
  return {
    cfg,
    agentDir: "/tmp/openclaw-model-identity-planner",
    env: {},
    pluginMetadataSnapshot,
  };
}

const pluginCatalogPath = encodePluginModelCatalogRelativePath("identity-fixture");

function readPluginProviders(plan: Awaited<ReturnType<typeof planOpenClawModelsJsonWithDeps>>) {
  const contents = plan.pluginCatalogWrites?.[pluginCatalogPath];
  assert(contents);
  return (JSON.parse(contents) as { providers: Record<string, ModelProviderConfig> }).providers;
}

describe("models config materialized identities", () => {
  it.each(["merge", "replace"] as const)(
    "materializes authored aliases once in %s mode",
    async (mode) => {
      const cfg: OpenClawConfig = {
        models: { mode, providers: { authored: provider([model("latest")]) } },
      };
      const plan = await planOpenClawModelsJsonWithDeps(
        { ...context(cfg), existingRaw: "", existingParsed: {} },
        { resolveImplicitProviders: async () => ({}) },
      );
      assert(plan.action === "write");
      const parsed = JSON.parse(plan.contents);
      expect(readPluginProviders(plan).authored?.models).toEqual([
        model("middle", { name: "latest" }),
      ]);
      expect(cfg.models?.providers?.authored?.models[0]?.id).toBe("latest");
      const repeated = await planOpenClawModelsJsonWithDeps(
        {
          ...context(cfg),
          existingRaw: plan.contents,
          existingParsed: parsed,
          pluginCatalogs: [
            {
              pluginId: "identity-fixture",
              contents: plan.pluginCatalogWrites![pluginCatalogPath]!,
            },
          ],
        },
        { resolveImplicitProviders: async () => ({}) },
      );
      expect(repeated).toEqual(plan);
    },
  );

  it("keeps implicit, generated, and manual root rows literal across publication", async () => {
    const literal = provider([
      model("latest", { contextWindow: 32_000 }),
      model("middle", { input: ["text", "image"] }),
    ]);
    const cfg: OpenClawConfig = {
      models: { providers: { authored: provider([model("latest")]) } },
    };
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        ...context(cfg),
        existingRaw: "",
        existingParsed: { providers: { manual: literal } },
        pluginCatalogs: [
          {
            pluginId: "identity-fixture",
            contents: JSON.stringify({
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: { generated: literal },
            }),
          },
        ],
      },
      { resolveImplicitProviders: async () => ({ implicit: literal }) },
    );
    assert(plan.action === "write");
    const root = JSON.parse(plan.contents);
    expect(root.providers.manual).toEqual(literal);
    expect(readPluginProviders(plan).authored?.models[0]?.id).toBe("middle");
    const pluginContents = plan.pluginCatalogWrites?.[pluginCatalogPath];
    assert(pluginContents);
    expect(readPluginProviders(plan)).toEqual({
      generated: literal,
      implicit: literal,
      authored: provider([model("middle", { name: "latest" })]),
    });
    const repeated = await planOpenClawModelsJsonWithDeps(
      {
        ...context(cfg),
        existingRaw: plan.contents,
        existingParsed: root,
        pluginCatalogs: [{ pluginId: "identity-fixture", contents: pluginContents }],
      },
      { resolveImplicitProviders: async () => ({ implicit: literal }) },
    );
    assert(repeated.action === "write");
    expect(repeated.contents).toBe(plan.contents);
    expect(repeated.pluginCatalogWrites).toEqual(plan.pluginCatalogWrites);
  });

  it.each([
    { reverse: false, aliasOnly: false },
    { reverse: true, aliasOnly: false },
    { reverse: false, aliasOnly: true },
  ])(
    "keeps authored metadata through both discovery merges (reversed=$reverse, aliasOnly=$aliasOnly)",
    async ({ reverse, aliasOnly }) => {
      const rows = [
        model("latest", {
          input: ["text"],
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        }),
        model("middle", {
          input: ["text", "image"],
          cost: { input: 7, output: 7, cacheRead: 7, cacheWrite: 7 },
        }),
        model("final", {
          input: ["text"],
          cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
        }),
      ];
      const discovered = provider([model("middle", { input: ["text", "image"] }), model("final")]);
      const { input: _input, cost: _cost, ...aliasWithoutMetadata } = model("latest");
      // Config rows may omit capabilities and pricing before catalog materialization.
      const sourceRows = aliasOnly
        ? [aliasWithoutMetadata as ModelDefinitionConfig]
        : reverse
          ? rows.toReversed()
          : rows;
      const plugin: ProviderPlugin = {
        id: "authored",
        pluginId: "identity-fixture",
        label: "Identity fixture",
        auth: [],
        staticCatalog: { run: async () => ({ provider: discovered }) },
      };
      const plan = await planOpenClawModelsJsonWithDeps({
        ...context({ models: { providers: { authored: provider(sourceRows) } } }),
        authStore: { version: 1, profiles: {} },
        preparedStaticProviderCatalog: {
          providers: [plugin],
          entries: [{ provider: plugin, result: { provider: discovered } }],
        },
        providerDiscoveryEntriesOnly: true,
        providerDiscoveryProviderIds: ["authored"],
        existingRaw: "",
        existingParsed: {},
      });
      assert(plan.action === "write");
      const published = readPluginProviders(plan).authored!.models;
      expect(published.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
        aliasOnly
          ? [model("middle", { name: "latest", input: ["text", "image"] })]
          : [rows[2], rows[1]],
      );
    },
  );
});
