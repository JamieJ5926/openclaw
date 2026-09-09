import { createApiRegistry } from "@openclaw/ai";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import type { PreparedModelRuntimeLeaseOptions } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const mocks = vi.hoisted(() => ({
  acquireRuntimeLease: vi.fn(),
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
  publishedGeneration: "A",
  readGeneration: (() => "unscoped") as () => string,
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireRuntimeLease,
}));

vi.mock("../plugins/runtime/generation-scope.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const generation = new AsyncLocalStorage<string>();
  mocks.readGeneration = () => generation.getStore() ?? mocks.publishedGeneration;
  return {
    getPluginRuntimeGenerationRegistry: () => undefined,
    withPluginRuntimeGenerationScope: (snapshot: { testGeneration?: string }, run: () => unknown) =>
      generation.run(snapshot.testGeneration ?? "unknown", run),
  };
});

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: Model) => model,
  applyLocalNoAuthHeaderOverride: (model: Model) => model,
  formatMissingAuthError: vi.fn(),
  getApiKeyForModelCore: mocks.getApiKeyForModel,
  resolveApiKeyForProviderCore: mocks.getApiKeyForModel,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  initializeModelRegistryRuntime: vi.fn(),
  getModelRegistryRuntime: () => {
    const apiRegistry = createApiRegistry();
    return { apiRegistry, llmRuntime: { registry: apiRegistry, streamSimple: vi.fn() } };
  },
}));

import {
  acquireSimpleCompletionModelForAgent,
  prepareSimpleCompletionModel,
  prepareSimpleCompletionModelFromRef,
} from "./simple-completion-runtime.js";

function createOllamaModelResolver(): typeof resolveModelAsync {
  return vi.fn(async (provider, modelId, _agentDir, _cfg, options) => ({
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model,
    authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
    modelRegistry: options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
  }));
}

beforeEach(() => {
  mocks.publishedGeneration = "A";
  mocks.acquireRuntimeLease.mockReset();
  mocks.getApiKeyForModel.mockReset();
  mocks.prepareProviderRuntimeAuth.mockReset();
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  mocks.acquireRuntimeLease.mockImplementation(async (input) => ({
    snapshot: {
      testGeneration: "A",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/runtime-workspace",
      config: input.config,
      authModes: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      allowGatewaySubagentBinding: false,
      modelCatalog: { entries: [] },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      activeProjectKeys: [],
      createStores: () => ({ authStorage, modelRegistry }),
    },
    release: vi.fn(),
  }));
});

it("keeps route rematerialization and runtime auth on the acquired generation", async () => {
  const observedModelGenerations: string[] = [];
  const observedRuntimeAuthGenerations: string[] = [];
  const modelResolver: typeof resolveModelAsync = vi.fn(
    async (provider, modelId, _agentDir, cfg, options) => {
      if (!options?.authStorage || !options.modelRegistry) {
        throw new Error("prepared stores were not bound");
      }
      const generation = mocks.readGeneration();
      observedModelGenerations.push(generation);
      const configured = cfg?.models?.providers?.openai;
      return {
        model: {
          provider,
          id: modelId,
          name: modelId,
          api: configured?.api ?? "openai-chatgpt-responses",
          baseUrl: configured?.baseUrl ?? "https://chatgpt.com/backend-api/codex",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
          params: { generation },
        } satisfies Model,
        authStorage: options.authStorage,
        modelRegistry: options.modelRegistry,
      };
    },
  );
  mocks.getApiKeyForModel.mockImplementation(async () => {
    await Promise.resolve();
    mocks.publishedGeneration = "B";
    return {
      apiKey: "sk-platform",
      profileId: "openai:platform",
      source: "profile:openai:platform",
      mode: "api-key",
    };
  });
  mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
    observedRuntimeAuthGenerations.push(mocks.readGeneration());
    return undefined;
  });

  const result = await prepareSimpleCompletionModel({
    cfg: {},
    agentId: "main",
    provider: "openai",
    modelId: "gpt-5.5",
    agentDir: "/tmp/openclaw-agent",
    modelResolver,
  });

  expect(result).not.toHaveProperty("error");
  if ("error" in result) {
    throw new Error(result.error);
  }
  expect(result.model.params).toMatchObject({ generation: "A" });
  expect(observedModelGenerations).toEqual(["A", "A"]);
  expect(observedRuntimeAuthGenerations).toEqual(["A"]);
});

it("acquires direct completion runtime for the exact selected model", async () => {
  const modelResolver = createOllamaModelResolver();
  mocks.getApiKeyForModel.mockResolvedValue({
    apiKey: "ollama-local",
    source: "local marker",
    mode: "api-key",
  });

  await prepareSimpleCompletionModel({
    cfg: {},
    agentId: "main",
    provider: "ollama",
    modelId: "qwen3:0.6b",
    agentDir: "/tmp/openclaw-agent",
    agentRuntimeId: "openclaw",
    modelResolver,
  });

  expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimePluginSelections: [
        {
          provider: "ollama",
          modelId: "qwen3:0.6b",
          runtime: "openclaw",
          agentId: "main",
        },
      ],
    }),
    expect.objectContaining({ catalogMode: "static" }),
  );
  expect(modelResolver).toHaveBeenCalledOnce();
});

it("validates the admitted selection before materialization or auth and releases a denied lease", async () => {
  const config = { agents: { defaults: { model: "ollama/old-model" } } };
  const admittedConfig = { agents: { defaults: { model: "ollama/admitted-model" } } };
  const acquire = expectDefined(mocks.acquireRuntimeLease.getMockImplementation(), "lease fixture");
  const release = vi.fn();
  mocks.acquireRuntimeLease.mockImplementationOnce(async (input) => {
    const lease = await acquire(input);
    return { ...lease, snapshot: { ...lease.snapshot, config: admittedConfig }, release };
  });
  const modelResolver = createOllamaModelResolver();
  const validate = vi.fn<NonNullable<Parameters<typeof prepareSimpleCompletionModelFromRef>[1]>>(
    ({ selection, config: selectedConfig }) => {
      expect(selectedConfig).toBe(admittedConfig);
      expect(selection).toMatchObject({ provider: "ollama", modelId: "admitted-model" });
      throw new Error("admitted model denied by policy");
    },
  );
  await expect(
    prepareSimpleCompletionModelFromRef(
      {
        cfg: config,
        agentId: "main",
        modelResolver,
      },
      validate,
    ),
  ).rejects.toThrow("admitted model denied by policy");
  expect(validate).toHaveBeenCalledOnce();
  expect(modelResolver).not.toHaveBeenCalled();
  expect(mocks.getApiKeyForModel).not.toHaveBeenCalled();
  expect(mocks.prepareProviderRuntimeAuth).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it("selects an explicit agent completion model from admitted metadata before materialization", async () => {
  const modelResolver = createOllamaModelResolver();
  const acquire = expectDefined(mocks.acquireRuntimeLease.getMockImplementation(), "lease fixture");
  mocks.acquireRuntimeLease.mockImplementationOnce(
    async (input, options: PreparedModelRuntimeLeaseOptions) => {
      const deriveSelections = expectDefined(
        options.deriveRuntimePluginSelections,
        "selection owner",
      );
      expect(
        deriveSelections({
          config: input.config,
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
        }),
      ).toEqual([{ provider: "ollama", modelId: "qwen3:0.6b", agentId: "main" }]);
      expect(modelResolver).not.toHaveBeenCalled();
      return await acquire(input, options);
    },
  );
  mocks.getApiKeyForModel.mockResolvedValue({
    apiKey: "ollama-local",
    source: "local marker",
    mode: "api-key",
  });

  const result = await acquireSimpleCompletionModelForAgent({
    cfg: {},
    agentId: "main",
    modelRef: "ollama/qwen3:0.6b",
    modelResolver,
  });

  try {
    expect(result).toMatchObject({ selection: { provider: "ollama", modelId: "qwen3:0.6b" } });
    expect(modelResolver).toHaveBeenCalledOnce();
  } finally {
    if (!("error" in result)) {
      result.release();
    }
  }
});
