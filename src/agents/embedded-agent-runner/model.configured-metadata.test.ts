import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/types.js";
import { buildConfiguredFallbackModel } from "./model.configured-fallback.js";
import { applyConfiguredProviderOverrides } from "./model.configured-overrides.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { resolveExplicitModelWithRegistry } from "./model.registry-resolution.js";

vi.mock("../model-suppression.js", () => ({
  shouldUnconditionallySuppress: () => false,
  shouldSuppressBuiltInModelCore: () => false,
  buildSuppressedBuiltInModelError: () => undefined,
}));
afterEach(clearRuntimeConfigSnapshot);

describe("configured model metadata source ownership", () => {
  it.each([
    ...[false, true].flatMap((explicit) =>
      [false, true].map((customRoute) => ({ explicit, customRoute, registryDisagrees: false })),
    ),
    { explicit: false, customRoute: false, registryDisagrees: true },
  ])(
    "uses literal runtime capabilities: overrides=$explicit / custom route=$customRoute / registry differs=$registryDisagrees",
    ({ explicit, customRoute, registryDisagrees }) => {
      const provider = "metadata-fixture";
      const literal = {
        id: "latest",
        name: "Literal latest",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        provider,
        api: "openai-completions" as const,
        baseUrl: "https://models.example/v1",
        reasoning: true,
        input: ["text", "image"] as Array<"text" | "image">,
        contextWindow: 16_000,
        contextTokens: 12_000,
        maxTokens: 2000,
        thinkingLevelMap: { minimal: "low" },
        compat: { supportsLongCacheRetention: true },
        mediaInput: { image: { maxSidePx: 1000, maxBytes: 111 } },
      };
      const overrides: Partial<ModelDefinitionConfig> = {
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        contextTokens: 24_000,
        maxTokens: 1000,
        thinkingLevelMap: { off: null, max: "max" },
        mediaInput: { image: { maxSidePx: 3000 } },
        compat: { supportsLongCacheRetention: false },
      };
      const seeded = {
        ...literal,
        reasoning: false,
        input: ["text"] as Array<"text" | "image">,
        contextWindow: 64_000,
        contextTokens: 48_000,
        maxTokens: 8000,
        thinkingLevelMap: { high: "high" },
        compat: { supportsLongCacheRetention: false },
        mediaInput: { image: { maxSidePx: 2000, maxBytes: 222 } },
        ...(explicit ? overrides : {}),
        ...(registryDisagrees ? { params: { fromInline: "inline" } } : {}),
      };
      const staticDonor = registryDisagrees
        ? {
            ...literal,
            name: "Static latest",
            params: { fromStatic: "static" },
            headers: { "X-Static": "static" },
          }
        : literal;
      const registryDonor = registryDisagrees
        ? {
            ...literal,
            name: "Registry latest",
            baseUrl: "https://registry.example/v1",
            contextWindow: 96_000,
            params: { fromRegistry: "registry" },
            headers: { "X-Registry": "registry" },
            cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
          }
        : literal;
      const providerConfig = {
        baseUrl: customRoute ? "https://custom.example/v1" : literal.baseUrl,
        api: literal.api,
        models: [
          { ...seeded, baseUrl: customRoute ? "https://custom.example/v1" : literal.baseUrl },
        ],
      };
      const runtime: OpenClawConfig = { models: { providers: { [provider]: providerConfig } } };
      const source = {
        models: {
          providers: {
            [provider]: {
              ...providerConfig,
              models: [{ id: "latest", ...(explicit ? overrides : {}) }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      setRuntimeConfigSnapshot(runtime, source);
      setCurrentManifestModelIdNormalizationPolicies(
        new Map([[provider, { aliases: { latest: "middle" } }]]),
      );
      try {
        const resolved = resolveExplicitModelWithRegistry({
          provider,
          modelId: "latest",
          cfg: runtime,
          manifestAlias: { provider },
          runtimeHooks: createProviderRuntimeTestMock(),
          ...(customRoute || registryDisagrees ? { getStaticCatalogModel: () => staticDonor } : {}),
          modelRegistry: {
            find: (providerId, modelId) =>
              providerId === provider && modelId === "latest" ? registryDonor : undefined,
            getAll: () => [registryDonor],
            getAvailable: () => [registryDonor],
            hasConfiguredAuth: () => true,
          },
        });
        const direct = applyConfiguredProviderOverrides({
          provider,
          modelId: "latest",
          cfg: runtime,
          providerConfig,
          manifestAlias: { provider },
          discoveredModel: literal,
        });
        const fallback = buildConfiguredFallbackModel({
          provider,
          modelId: "latest",
          cfg: runtime,
          manifestAlias: { provider },
          getStaticCatalogModel: () => literal,
          runtimeHooks: createProviderRuntimeTestMock(),
        });
        expect(resolved?.kind).toBe("resolved");
        if (registryDisagrees && resolved?.kind === "resolved") {
          expect(resolved.model).toMatchObject({
            name: literal.name,
            api: literal.api,
            baseUrl: literal.baseUrl,
            cost: registryDonor.cost,
          });
          expect(resolved.model.headers).toEqual({ "X-Static": "static" });
          expect(resolved.model.params).toEqual({ fromInline: "inline", fromStatic: "static" });
        }
        for (const { model, registryOnly } of [
          {
            model: resolved?.kind === "resolved" ? resolved.model : undefined,
            registryOnly: !customRoute && !registryDisagrees,
          },
          { model: direct, registryOnly: false },
          { model: fallback, registryOnly: false },
        ]) {
          expect(model).toMatchObject({
            id: "latest",
            reasoning: !explicit,
            input: explicit ? ["text"] : ["text", "image"],
            contextWindow: explicit ? 32_000 : 16_000,
            contextTokens: explicit ? 24_000 : 12_000,
            maxTokens: explicit ? 1000 : 2000,
            thinkingLevelMap: explicit ? overrides.thinkingLevelMap : literal.thinkingLevelMap,
            mediaInput: { image: { maxSidePx: explicit ? 3000 : 1000, maxBytes: 111 } },
          });
          expect(model?.compat?.supportsLongCacheRetention).toBe(
            customRoute ? (explicit ? false : undefined) : !(registryOnly && explicit),
          );
        }
      } finally {
        setCurrentManifestModelIdNormalizationPolicies(undefined);
      }
    },
  );
});
