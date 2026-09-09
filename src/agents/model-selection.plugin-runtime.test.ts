// Covers plugin-owned model id normalization through selection surfaces.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();

function normalizeLegacyFixtureModel({
  provider,
  context,
}: {
  provider: string;
  context: { modelId?: string };
}) {
  return provider === "custom-provider" && context.modelId === "custom-legacy-model"
    ? "custom-modern-model"
    : undefined;
}

const emptyPluginMetadataSnapshot = {
  configFingerprint: "model-selection-plugin-runtime-test-empty-plugin-metadata",
  ...createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "google-model-normalizer",
        modelIdNormalization: {
          providers: {
            google: {
              aliases: {
                "gemini-3.1-pro": "gemini-3.1-pro-preview",
              },
            },
          },
        },
      },
    ],
  }),
};
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const loadPreparedModelCatalogSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("./model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: () => [],
  loadProviderScopedThinkingCatalog: async () => [],
  readPreparedModelCatalog: async () => [],
  loadPreparedModelCatalogSnapshot: loadPreparedModelCatalogSnapshotMock,
}));

let createModelSelectionStateForTest: typeof import("../auto-reply/reply/model-selection.js").createModelSelectionState;
let resolveSessionModelRef: typeof import("./session-model-ref.js").resolveSessionModelRef;

describe("model-selection plugin runtime normalization", () => {
  beforeAll(async () => {
    ({ createModelSelectionState: createModelSelectionStateForTest } =
      await import("../auto-reply/reply/model-selection.js"));
    ({ resolveSessionModelRef } = await import("./session-model-ref.js"));
  });

  beforeEach(() => {
    normalizeProviderModelIdWithPluginMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(emptyPluginMetadataSnapshot);
    loadPreparedModelCatalogSnapshotMock.mockReset();
    loadPreparedModelCatalogSnapshotMock.mockResolvedValue({ entries: [], authoritative: true });
  });

  it("delegates provider-owned model id normalization to plugin runtime hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { parseModelRef } = await import("./model-selection.js");

    expect(parseModelRef("custom-legacy-model", "custom-provider")).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith({
      provider: "custom-provider",
      context: {
        provider: "custom-provider",
        modelId: "custom-legacy-model",
      },
    });
  });

  it("keeps static normalization while skipping plugin runtime hooks when disabled", async () => {
    const { parseModelRef } = await import("./model-selection.js");

    expect(
      parseModelRef("gemini-3.1-pro", "google", {
        allowPluginNormalization: false,
      }),
    ).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("keeps provider plugin normalization when inferring provider for bare defaults", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { resolveConfiguredModelRef } = await import("./model-selection.js");

    expect(
      resolveConfiguredModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "custom-legacy-model" },
              models: {
                "custom-provider/custom-legacy-model": {},
              },
            },
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        allowPluginNormalization: true,
      }),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
  });

  it.each([
    ["keeps model visibility policy construction off plugin runtime hooks by default", undefined],
    [
      "propagates explicit plugin runtime normalization opt-in through model visibility policy",
      true,
    ],
  ] as const)("%s", async (_name, allowPluginNormalization) => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
    const policy = createModelVisibilityPolicy({
      cfg: {
        agents: { defaults: { models: { "custom-provider/custom-legacy-model": {} } } },
      },
      catalog: [],
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      ...(allowPluginNormalization ? { allowPluginNormalization } : {}),
    });

    if (allowPluginNormalization) {
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(true);
      expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
    } else {
      expect(policy.allowedKeys.has("custom-provider/custom-legacy-model")).toBe(true);
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(false);
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("enforces policy on exact legacy pins (excluded=%s)", async (excluded) => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const cfg = {
      agents: {
        defaults: {
          models: {
            "custom-provider/custom-legacy-model": {},
          },
          modelPolicy: excluded ? { allow: ["custom-provider/custom-modern-model"] } : {},
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = {
      sessionId: sessionKey,
      updatedAt: 1,
      providerOverride: "custom-provider",
      modelOverride: "custom-legacy-model",
    };
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "custom-modern-model",
      provider: "custom-provider",
      model: "custom-modern-model",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe(excluded ? "custom-modern-model" : "custom-legacy-model");
    expect(state.resetModelOverride).toBe(excluded);
    expect(state.resetModelOverrideReason).toBe(excluded ? "disallowed" : undefined);
    expect(state.resetModelOverrideRef).toBe(
      excluded ? "custom-provider/custom-legacy-model" : undefined,
    );
    expect(sessionEntry.modelOverride).toBe(excluded ? undefined : "custom-legacy-model");
  });

  it.each(["middle", "latest"])(
    "resolves %s against the admitted catalog before visibility",
    async (input) => {
      normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) =>
        context.modelId === "latest"
          ? "middle"
          : context.modelId === "middle"
            ? "final"
            : undefined,
      );
      const cfg = {
        agents: {
          defaults: {
            model: { primary: `custom-provider/${input}` },
            modelPolicy: { allow: ["custom-provider/middle"] },
          },
        },
      };
      const catalog = [
        { provider: "custom-provider", id: "middle", name: "Selected" },
        { provider: "custom-provider", id: "final", name: "Other" },
      ];
      const { resolveDefaultModelForAgent } = await import("./model-selection-config.js");
      const selected = resolveDefaultModelForAgent({
        cfg,
        allowPluginNormalization: true,
        manifestPlugins: emptyPluginMetadataSnapshot,
        resolvedModelCatalog: catalog,
      });
      const state = await createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultProvider: selected.provider,
        defaultModel: selected.model,
        ...selected,
        hasModelDirective: false,
        preparedModelCatalog: {
          routeVariants: [],
          entries: catalog,
        },
      });
      expect(state.provider).toBe("custom-provider");
      expect(state.model).toBe("middle");
      expect(state.modelPolicy.allows({ provider: "custom-provider", model: "middle" })).toBe(true);
      expect(state.modelPolicy.allows({ provider: "custom-provider", model: "final" })).toBe(false);
    },
  );

  it("keeps a normalized default authorized when its target is absent from the captured catalogue", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) =>
      context.modelId === "latest" ? "middle" : context.modelId === "middle" ? "final" : undefined,
    );
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "custom-provider/latest" },
          modelPolicy: { allow: ["custom-provider/latest"] },
        },
      },
    };
    const catalog = [{ provider: "custom-provider", id: "final", name: "Other" }];
    const { resolveDefaultModelForAgent } = await import("./model-selection-config.js");
    const selected = resolveDefaultModelForAgent({
      cfg,
      allowPluginNormalization: true,
      manifestPlugins: emptyPluginMetadataSnapshot,
      resolvedModelCatalog: catalog,
    });
    expect(selected).toEqual({ provider: "custom-provider", model: "middle" });
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider: selected.provider,
      defaultModel: selected.model,
      ...selected,
      hasModelDirective: false,
      preparedModelCatalog: { entries: catalog, routeVariants: catalog },
    });
    expect(state.model).toBe("middle");
    expect(state.modelPolicy.allows({ provider: state.provider, model: state.model })).toBe(true);
    expect(state.modelPolicy.allows({ provider: "custom-provider", model: "final" })).toBe(false);
  });

  it.each([
    { name: "recorded", model: "custom-modern-model", routeResolution: "resolved" },
    { name: "pre-source", model: "custom-legacy-model", routeResolution: undefined },
  ] as const)(
    "keeps $name persisted selections off runtime hooks",
    ({ model, routeResolution }) => {
      normalizeProviderModelIdWithPluginMock.mockReturnValue("incorrectly-renormalized-model");

      expect(
        resolveSessionModelRef(
          {},
          {
            providerOverride: "custom-provider",
            modelOverride: model,
            ...(routeResolution ? { modelOverrideRouteResolution: routeResolution } : {}),
          },
          "main",
        ),
      ).toEqual({ provider: "custom-provider", model });
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    },
  );

  it("reuses one lifecycle metadata snapshot across auto-reply model normalization", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const configuredRefs = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`custom-provider/model-${index}`, {}]),
    );
    const cfg = {
      agents: {
        defaults: {
          modelPolicy: { allow: Object.keys(configuredRefs) },
          models: configuredRefs,
        },
      },
    };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider: "custom-provider",
      defaultModel: "model-0",
      provider: "custom-provider",
      model: "model-0",
      hasModelDirective: false,
    });

    expect(state.allowedModelCatalog).toHaveLength(20);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    });
  });

  it("keeps concurrent model-policy runs isolated while sharing metadata", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    let signalFirstCatalogLoad: (() => void) | undefined;
    let releaseFirstCatalogLoad: (() => void) | undefined;
    const firstCatalogLoadStarted = new Promise<void>((resolve) => {
      signalFirstCatalogLoad = resolve;
    });
    const firstCatalogLoadRelease = new Promise<void>((resolve) => {
      releaseFirstCatalogLoad = resolve;
    });
    loadPreparedModelCatalogSnapshotMock
      .mockImplementationOnce(async () => {
        signalFirstCatalogLoad?.();
        await firstCatalogLoadRelease;
        return { entries: [], authoritative: true };
      })
      .mockResolvedValue({ entries: [], authoritative: true });
    const createConfig = (model: string) => ({
      agents: {
        defaults: {
          modelPolicy: { allow: [`custom-provider/${model}`] },
          models: { [`custom-provider/${model}`]: {} },
        },
      },
    });
    const firstConfig = createConfig("first");
    const secondConfig = createConfig("second");

    const select = (cfg: ReturnType<typeof createConfig>, model: string) =>
      createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultProvider: "custom-provider",
        defaultModel: model,
        provider: "custom-provider",
        model,
        hasModelDirective: true,
      });

    const firstPromise = select(firstConfig, "first");
    await firstCatalogLoadStarted;
    const secondPromise = select(secondConfig, "second");
    await vi.waitFor(() => expect(loadPreparedModelCatalogSnapshotMock).toHaveBeenCalledTimes(2));
    releaseFirstCatalogLoad?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([...first.allowedModelKeys]).toContain("custom-provider/first");
    expect([...first.allowedModelKeys]).not.toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).not.toContain("custom-provider/first");
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(2);
    expect(getCurrentPluginMetadataSnapshotMock.mock.calls).toEqual([
      [{ config: firstConfig, allowWorkspaceScopedSnapshot: true }],
      [{ config: secondConfig, allowWorkspaceScopedSnapshot: true }],
    ]);
  });

  it("normalizes configured and fallback refs while preserving the selected stored ref", async () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    const aliases = new Map([
      ["configured-legacy", "configured-modern"],
      ["stored-legacy", "stored-modern"],
      ["fallback-legacy", "fallback-modern"],
    ]);
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) => {
      const modelId = (context as { modelId?: string }).modelId ?? "";
      return aliases.get(modelId);
    });
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "custom-provider/configured-legacy",
            fallbacks: ["custom-provider/fallback-legacy"],
          },
          modelPolicy: {
            allow: ["custom-provider/configured-legacy", "custom-provider/stored-legacy"],
          },
          models: {
            "custom-provider/configured-legacy": {},
            "custom-provider/stored-legacy": {},
          },
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = {
      sessionId: sessionKey,
      updatedAt: 1,
      providerOverride: "custom-provider",
      modelOverride: "stored-modern",
    };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "configured-legacy",
      provider: "custom-provider",
      model: "configured-legacy",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("stored-modern");
    expect([...state.allowedModelKeys]).toEqual(
      expect.arrayContaining([
        "custom-provider/configured-modern",
        "custom-provider/stored-modern",
      ]),
    );
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    });
    expect(
      normalizeProviderModelIdWithPluginMock.mock.calls.map(
        ([call]) => (call as { context?: { modelId?: string } }).context?.modelId,
      ),
    ).toEqual(expect.arrayContaining(["configured-legacy", "stored-legacy", "fallback-legacy"]));
  });
});
