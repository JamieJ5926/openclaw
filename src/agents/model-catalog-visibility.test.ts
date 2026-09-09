/**
 * Regression coverage for model catalog visibility filtering.
 * Keeps provider/model allow and hide rules aligned with catalog row metadata.
 */
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { materializeRuntimeConfig } from "../config/materialize.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";

describe("resolveLogicalVisibleModelCatalog", () => {
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each(["all", "configured", "default"] as const)(
    "keeps case-distinct configured identities in the %s view",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "fixture", id: "MixedCase", name: "Large", contextWindow: 64_000 },
        { provider: "fixture", id: "mixedcase", name: "Small", contextWindow: 16_000 },
      ];
      const result = await resolveLogicalVisibleModelCatalog({
        cfg: { agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } } },
        catalog,
        defaultProvider: "fixture",
        view,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: async () =>
          resolveLogicalModelCatalogEntryState({
            evaluation: { availability: true, routeResolution: null },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      });

      expect(result).toEqual(expect.arrayContaining(catalog));
      expect(result).toHaveLength(2);
    },
  );

  it("keeps a literal catalog suffix distinct from its base model", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "fixture", id: "reader", name: "Base" },
      { provider: "fixture", id: "reader@variant", name: "Literal variant" },
    ];
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {},
      catalog,
      defaultProvider: "fixture",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: { availability: true, routeResolution: null },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual(expect.arrayContaining(catalog));
    expect(result).toHaveLength(2);
  });

  const selectedRoute = {
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authRequirement: "subscription" as const,
    requestTransportOverrides: "none" as const,
  };
  const platform: ModelCatalogEntry = {
    provider: "openai",
    id: "gpt-5.5",
    name: "Platform GPT-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text", "image"],
  };
  const chatGPT: ModelCatalogEntry = {
    provider: "openai",
    id: "gpt-5.5",
    name: "ChatGPT GPT-5.5",
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    contextWindow: 400_000,
    reasoning: false,
    input: ["text"],
  };

  const evaluateAvailableEntry = async () =>
    resolveLogicalModelCatalogEntryState({
      evaluation: { availability: true, routeResolution: null },
      routePolicy: openAIModelCatalogRoutePolicy,
    });

  it.each([
    { name: "sparse direct selector", id: "middle", overrides: {}, clearsCapabilities: false },
    { name: "sparse alias selector", id: "latest", overrides: {}, clearsCapabilities: false },
    {
      name: "explicit capability overrides",
      id: "middle",
      overrides: { contextWindow: 16_000, input: ["text", "image"], reasoning: false },
      clearsCapabilities: false,
    },
    {
      name: "changed API",
      id: "middle",
      overrides: { api: "openai-completions" },
      clearsCapabilities: true,
    },
    {
      name: "changed endpoint",
      id: "middle",
      overrides: { baseUrl: "https://other-fixture.invalid/v1" },
      clearsCapabilities: true,
    },
  ] satisfies Array<{
    name: string;
    id: string;
    overrides: Partial<ModelDefinitionConfig>;
    clearsCapabilities: boolean;
  }>)("preserves catalog capabilities for $name in the default view", async (testCase) => {
    const api = "openai-responses";
    const baseUrl = "https://fixture.invalid/v1";
    const catalog = [
      {
        provider: "fixture",
        id: "latest",
        name: "Latest",
        api,
        baseUrl,
        contextWindow: 64_000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        provider: "fixture",
        id: "middle",
        name: "Middle",
        api,
        baseUrl,
        contextWindow: 128_000,
        input: ["text"],
        reasoning: true,
      },
    ] satisfies ModelCatalogEntry[];
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture",
          providers: ["fixture"],
          ...(testCase.id === "latest"
            ? {
                modelIdNormalization: {
                  providers: { fixture: { aliases: { latest: "middle", middle: "final" } } },
                },
              }
            : {}),
          modelCatalog: { providers: { fixture: { api, baseUrl, models: catalog } } },
        },
      ],
    });
    const validated = validateConfigObjectRaw({
      models: {
        providers: {
          fixture: {
            api,
            baseUrl,
            models: [{ id: testCase.id, name: "Configured", ...testCase.overrides }],
          },
        },
      },
      agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } }, entries: { main: {} } },
    });
    assert(validated.ok, JSON.stringify(validated));
    const source = validated.config;
    const runtime = materializeRuntimeConfig(source, {
      env: {},
      manifestRegistry: metadataSnapshot.manifestRegistry,
    });
    setRuntimeConfigSnapshot(runtime, source);
    const result = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      resolveLogicalVisibleModelCatalog({
        cfg: runtime,
        catalog,
        defaultProvider: "fixture",
        policy: createModelVisibilityPolicy({
          cfg: runtime,
          catalog,
          defaultProvider: "fixture",
          manifestPlugins: metadataSnapshot,
        }),
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: evaluateAvailableEntry,
      }),
    );
    const middle = result.find(({ id }) => id === "middle");
    expect(middle).toMatchObject({
      provider: "fixture",
      name: "Configured",
      api: testCase.overrides.api ?? api,
      baseUrl: testCase.overrides.baseUrl ?? baseUrl,
    });
    expect(middle?.contextWindow).toBe(
      testCase.clearsCapabilities ? undefined : (testCase.overrides.contextWindow ?? 128_000),
    );
    expect(middle?.input).toEqual(
      testCase.clearsCapabilities ? undefined : (testCase.overrides.input ?? ["text"]),
    );
    expect(middle?.reasoning).toBe(
      testCase.clearsCapabilities ? undefined : (testCase.overrides.reasoning ?? true),
    );
    expect(result.find(({ id }) => id === "latest")?.contextWindow).toBe(64_000);
    expect(result.some(({ id }) => id === "final")).toBe(false);
  });

  it.each(["all", "default", "configured"] as const)(
    "keeps case-distinct provider models separate in %s",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "custom", id: "Alpha", name: "Upper", contextWindow: 32000 },
        { provider: "custom", id: "alpha", name: "Lower", contextWindow: 64000 },
      ];
      const cfg = {
        agents: { defaults: { modelPolicy: { allow: ["custom/Alpha", "custom/alpha"] } } },
      };
      const policy = createModelVisibilityPolicy({
        cfg,
        catalog,
        defaultProvider: "custom",
        allowManifestNormalization: false,
        allowPluginNormalization: false,
      });
      const result = await resolveLogicalVisibleModelCatalog({
        cfg,
        catalog,
        defaultProvider: "custom",
        view,
        policy,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: evaluateAvailableEntry,
      });
      expect(result).toEqual(expect.arrayContaining(catalog));
      expect(result).toHaveLength(2);
    },
  );

  it.each(["default", "configured"] as const)(
    "hides deprecated and disabled rows from the %s picker view",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "demo", id: "current", name: "Current", status: "available" },
        { provider: "demo", id: "old", name: "Old", status: "deprecated" },
        { provider: "demo", id: "off", name: "Off", status: "disabled" },
      ];

      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog,
        defaultProvider: "demo",
        view,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: evaluateAvailableEntry,
      });

      expect(result.map((entry) => entry.id)).toEqual(["current"]);
    },
  );

  it("keeps deprecated and disabled rows in the all inventory", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "demo", id: "old", name: "Old", status: "deprecated" },
      { provider: "demo", id: "off", name: "Off", status: "disabled" },
    ];

    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "demo",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual(["off", "old"]);
  });

  it("preserves provider-owned strongest-first order through route projection", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", providerOrder: 3 },
      { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", providerOrder: 2 },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerOrder: 0 },
      { provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra", providerOrder: 1 },
    ];

    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "openai",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: {
            availability: true,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
            selectedRoute,
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result.map((entry) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
    ]);
  });

  it("keeps deprecated configured primary and alias-key rows visible", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "demo", id: "primary", name: "Primary", status: "deprecated" },
      { provider: "demo", id: "alias-key", name: "Alias Key", status: "deprecated" },
      { provider: "demo", id: "hidden", name: "Hidden", status: "deprecated" },
    ];
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "demo/primary" },
          models: { "demo/alias-key": { alias: "legacy" } },
        },
      },
    } as OpenClawConfig;
    // This unit test covers configured-row retention, not runtime plugin
    // discovery. Keep fake provider refs on the deterministic static path.
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog,
      defaultProvider: "demo",
      defaultModel: "primary",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "demo",
      defaultModel: "primary",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual(["alias-key", "primary"]);
  });

  it.each(["all", "default", "configured"] as const)(
    "dedupes physical routes after selected-route projection in the %s view",
    async (view) => {
      const catalog = [
        { ...platform, alias: "platform" },
        { ...chatGPT, alias: "selected" },
      ];
      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog,
        defaultProvider: "openai",
        view,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: async () =>
          resolveLogicalModelCatalogEntryState({
            evaluation: {
              availability: true,
              routeResolution: { kind: "routes", routes: [selectedRoute] },
              selectedRoute,
            },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      });

      expect(result).toEqual([
        {
          provider: "openai",
          id: "gpt-5.5",
          name: "ChatGPT GPT-5.5",
          alias: view === "all" ? "platform" : "selected",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 400_000,
          reasoning: false,
          input: ["text"],
        },
      ]);
    },
  );

  it.each([
    ["deprecated", []],
    ["available", ["gpt-5.5"]],
  ] as const)("uses the selected route's %s lifecycle status", async (status, expectedIds) => {
    const platformAvailable = { ...platform, status: "available" as const };
    const chatGPTSelected = { ...chatGPT, status };
    const catalog = [platformAvailable, chatGPTSelected];
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      routeVariants: catalog,
      defaultProvider: "openai",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: {
            availability: true,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
            selectedRoute,
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result.map((entry) => entry.id)).toEqual(expectedIds);
  });

  it("omits physical capabilities while managed route selection is unresolved", async () => {
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog: [platform],
      defaultProvider: "openai",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: {
            availability: false,
            routeResolution: { kind: "indeterminate", defaultRuntimeId: "codex" },
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual([{ provider: "openai", id: "gpt-5.5", name: "Platform GPT-5.5" }]);
  });

  it.each([false, true])(
    "projects one canonical nano row from reversed physical variants (reverse=%s)",
    async (reverse) => {
      const platformNano: ModelCatalogEntry = {
        ...platform,
        id: "gpt-5.4-nano",
        name: "Platform Nano",
      };
      const chatGPTNano: ModelCatalogEntry = {
        ...chatGPT,
        id: "gpt-5.4-nano",
        name: "ChatGPT Nano",
      };
      const routeVariants = reverse ? [platformNano, chatGPTNano] : [chatGPTNano, platformNano];
      const evaluateEntry = vi.fn(
        async (_entry: ModelCatalogEntry, _variants: readonly ModelCatalogEntry[]) =>
          resolveLogicalModelCatalogEntryState({
            evaluation: {
              availability: true,
              routeResolution: { kind: "routes", routes: [selectedRoute] },
              selectedRoute,
            },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      );

      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog: [platformNano],
        routeVariants,
        defaultProvider: "openai",
        view: "all",
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry,
      });

      expect(evaluateEntry).toHaveBeenCalledOnce();
      expect(evaluateEntry.mock.calls[0]?.[1]).toEqual(routeVariants);
      expect(result).toEqual([
        {
          provider: "openai",
          id: "gpt-5.4-nano",
          name: "ChatGPT Nano",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 400_000,
          reasoning: false,
          input: ["text"],
        },
      ]);
    },
  );
});
