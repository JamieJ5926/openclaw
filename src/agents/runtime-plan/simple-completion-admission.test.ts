import fs from "node:fs";
import type { RequestListener } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SsrFBlockedError } from "../../infra/net/ssrf.js";
import {
  describeImageWithModelCore,
  describeImagesWithModelCore,
} from "../../media-understanding/image.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import type { LlmIsolatedAgentRuntimeCompleteParams } from "../../plugins/runtime/types-core.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../../plugins/test-helpers/fs-fixtures.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { summarizeText } from "../../tts/tts-core.js";
import { resolveTtsConfig } from "../../tts/tts-settings.js";
import { upsertAuthProfileWithLockOrThrow } from "../auth-profiles/upsert-with-lock.js";
import {
  acquireAgentRunPreparedModelRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModel,
  acquireSimpleCompletionModelForAgent,
} from "../simple-completion-runtime.js";

const roots = createSyncSuiteTempRootTracker("openclaw-completion-admission");
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  roots.cleanup();
});

it.each([
  "direct-revoked",
  "isolated-revoked",
  "isolated-profile-revoked",
  "isolated-reasoning-revoked",
  "isolated-allowed",
  "isolated-model-granted",
  "direct-agent-revoked",
  "isolated-agent-revoked",
  "direct-agent-granted",
  "isolated-agent-granted",
  "direct-agent-host",
  "isolated-agent-host",
  "direct-default-changed",
  "isolated-default-changed",
] as const)("uses admitted plugin completion policy for %s", async (mode) => {
  const root = fs.realpathSync(roots.makeTempDir());
  const fixture = createColdPluginFixture({ rootDir: root, providerId: "policy-fixture" });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
      api.registerProvider({ id: "policy-fixture", label: "Fixture", auth: [] });
    } };`,
  );
  const wire: Array<{ path: string | undefined; model: string }> = [];
  await withServer(
    (request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as { model: string };
        wire.push({ path: request.url, model: body.model });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "policy-fixture",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [
              { index: 0, delta: { content: "admitted-policy-ok" }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    },
    async (baseUrl) => {
      const workspace = path.join(root, "workspace");
      const agentDir = path.join(root, "agent");
      const configPath = path.join(root, "config.json");
      fs.mkdirSync(workspace);
      const configFor = (owner: "a" | "b"): OpenClawConfig => ({
        agents: {
          defaults: {
            model: `policy-fixture/${mode.endsWith("default-changed") && owner === "b" ? "other" : "canonical"}`,
            workspace,
          },
          entries: {
            main: { agentDir, workspace },
            worker: { agentDir: path.join(root, "worker"), workspace },
          },
        },
        models: {
          providers: {
            "policy-fixture": {
              api: "openai-completions",
              baseUrl: `${baseUrl}/${owner}/v1`,
              apiKey: `fixture-${owner}`,
              request: { allowPrivateNetwork: true },
              models: ["canonical", "other"].map((id) => ({
                id,
                name: id,
                api: "openai-completions",
                reasoning: mode.includes("reasoning") && owner === "a",
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 256,
              })),
            },
          },
        },
        plugins: {
          allow: [fixture.pluginId],
          load: { paths: [root] },
          slots: { memory: "none" },
          entries: {
            [fixture.pluginId]: {
              enabled: true,
              llm: {
                allowedCompletionModels: mode.endsWith("default-changed")
                  ? ["policy-fixture/canonical", "policy-fixture/other"]
                  : [
                      (owner === "b" &&
                        (mode === "direct-revoked" || mode === "isolated-revoked")) ||
                      (owner === "a" && mode === "isolated-model-granted")
                        ? "policy-fixture/other"
                        : "policy-fixture/canonical",
                    ],
                allowAuthProfileOverride: owner === "a",
                allowAgentIdOverride:
                  (mode.endsWith("agent-revoked") && owner === "a") ||
                  (mode.endsWith("agent-granted") && owner === "b"),
              },
            },
          },
        },
      });
      const cfg = configFor("a");
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          fs.writeFileSync(configPath, JSON.stringify(cfg));
          if (mode.includes("profile")) {
            await upsertAuthProfileWithLockOrThrow({
              agentDir,
              profileId: "policy-fixture:pinned",
              credential: { type: "api_key", provider: "policy-fixture", key: "fixture-pinned" },
            });
          }
          await refreshPreparedModelRuntimeSnapshots(configFor("b"), {
            gatewayLifecycle: true,
            catalogMode: "static",
          });
          const { createRuntimeLlm } = await import("../../plugins/runtime/runtime-llm.runtime.js");
          const llm = createRuntimeLlm({
            getConfig: () => cfg,
            authority: {
              // Exact target grants precede preparation; broad overrides use the host cases.
              ...(mode.endsWith("agent-granted")
                ? { agentId: "worker" }
                : mode.includes("-agent-")
                  ? {}
                  : { agentId: "main" }),
              ...(mode.endsWith("agent-host") ? { allowAgentIdOverride: true } : {}),
              caller: { kind: "plugin", id: fixture.pluginId },
            },
          });
          const messages: LlmIsolatedAgentRuntimeCompleteParams["messages"] = [
            { role: "user", content: "Reply with the fixture marker." },
          ];
          const request = llm.complete({
            messages,
            ...(mode.includes("-agent-") ? { agentId: "worker" } : {}),
            ...(mode.includes("reasoning") ? { reasoning: "high" as const } : {}),
            ...(mode.startsWith("isolated")
              ? {
                  execution: {
                    mode: "isolated-agent-runtime" as const,
                    ...(mode.includes("profile") ? { authProfileId: "policy-fixture:pinned" } : {}),
                  },
                }
              : {}),
          });
          if (
            mode.endsWith("allowed") ||
            mode.endsWith("granted") ||
            mode.endsWith("host") ||
            mode.endsWith("changed")
          ) {
            const model = mode.endsWith("default-changed") ? "other" : "canonical";
            await expect(request).resolves.toMatchObject({
              text: "admitted-policy-ok",
              model,
              agentId: mode.includes("-agent-") ? "worker" : "main",
            });
            expect(wire).toEqual([{ path: "/b/v1/chat/completions", model }]);
          } else {
            await expect(request).rejects.toMatchObject({
              code: mode.includes("reasoning")
                ? "LLM_ISOLATED_INPUT_REJECTED"
                : "LLM_COMPLETION_NOT_AUTHORIZED",
            });
            expect(wire).toEqual([]);
          }
        },
      );
    },
  );
});

it.each(["reloaded", "revoked", "pinned", "borrowed", "borrowed-revoked"] as const)(
  "keeps MiniMax fallback on its %s admitted transport and auth owner",
  async (mode) => {
    const root = fs.realpathSync(roots.makeTempDir());
    const fixture = createColdPluginFixture({ rootDir: root, providerId: "minimax" });
    const wire: Array<{
      owner: string;
      path: string | undefined;
      authorization: string | undefined;
    }> = [];
    const handler =
      (owner: string): RequestListener =>
      (request, response) => {
        request.resume();
        request.on("end", () => {
          wire.push({ owner, path: request.url, authorization: request.headers.authorization });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ base_resp: { status_code: 0 }, content: "minimax-owner-ok" }),
          );
        });
      };
    await withServer(handler("a"), async (urlA) => {
      await withServer(handler("b"), async (urlB) => {
        const configPath = path.join(root, "config.json");
        const agentDir = path.join(root, "state", "agents", "main", "agent");
        const workspace = path.join(root, "workspace");
        fs.mkdirSync(workspace);
        const configFor = (owner: "a" | "b"): OpenClawConfig => ({
          agents: {
            defaults: { model: "minimax/MiniMax-VL-01", workspace },
            entries: { main: { agentDir, workspace } },
          },
          models: {
            providers: {
              minimax: {
                api: "anthropic-messages",
                apiKey: `fixture-${owner}`,
                baseUrl: `${owner === "a" ? urlA : urlB}/anthropic`,
                models: [],
                request: { allowPrivateNetwork: owner === "a" || !mode.includes("revoked") },
              },
            },
          },
          plugins: {
            allow: [fixture.pluginId],
            load: { paths: [root] },
            slots: { memory: "none" },
            entries: { [fixture.pluginId]: { enabled: true } },
          },
        });
        const cfgA = configFor("a");
        await withEnvAsync(
          {
            ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            MINIMAX_API_HOST: undefined,
            MINIMAX_API_KEY: undefined,
          },
          async () => {
            fs.writeFileSync(configPath, JSON.stringify(cfgA));
            if (mode === "pinned") {
              // Canonical presence permits the pin; the distinct request-store key must still win.
              await upsertAuthProfileWithLockOrThrow({
                agentDir,
                profileId: "pinned",
                credential: { type: "api_key", provider: "minimax", key: "fixture-canonical" },
              });
            }
            const borrowed = mode.startsWith("borrowed")
              ? await acquireAgentRunPreparedModelRuntime(
                  {
                    config: cfgA,
                    agentId: "main",
                    agentDir,
                    workspaceDir: workspace,
                    loadRuntimePlugins: true,
                    runtimePluginSelections: [
                      { provider: "minimax", modelId: "MiniMax-VL-01", agentId: "main" },
                    ],
                  },
                  { catalogMode: "static" },
                )
              : undefined;
            try {
              if (!borrowed) {
                await refreshPreparedModelRuntimeSnapshots(configFor("b"), {
                  gatewayLifecycle: true,
                  catalogMode: "static",
                });
              }
              const result = describeImageWithModelCore({
                cfg: borrowed ? configFor("b") : cfgA,
                ...(borrowed ? { preparedModelRuntime: borrowed.snapshot } : {}),
                agentId: "main",
                agentDir,
                workspaceDir: workspace,
                provider: "minimax",
                model: "MiniMax-VL-01",
                ...(mode === "pinned"
                  ? {
                      profile: "pinned",
                      authStore: {
                        version: 1,
                        profiles: {
                          pinned: { type: "api_key", provider: "minimax", key: "fixture-pin" },
                        },
                      },
                    }
                  : {}),
                buffer: Buffer.from("png-bytes"),
                mime: "image/png",
                fileName: "fixture.png",
                prompt: "Describe the synthetic image.",
                timeoutMs: 10_000,
              });
              if (mode.includes("revoked")) {
                await expect(result).rejects.toBeInstanceOf(SsrFBlockedError);
                expect(wire).toEqual([]);
              } else {
                expect(await result).toEqual({ text: "minimax-owner-ok", model: "MiniMax-VL-01" });
                expect(wire).toEqual([
                  {
                    owner: "b",
                    path: "/v1/coding_plan/vlm",
                    authorization: `Bearer fixture-${mode === "pinned" ? "pin" : "b"}`,
                  },
                ]);
              }
            } finally {
              borrowed?.release();
            }
          },
        );
      });
    });
  },
);

it.each([
  "agent",
  "utility",
  "utility-disabled",
  "tts",
  "tts-default",
  "tts-bare",
  "reloaded-tts",
  "image",
  "reloaded-agent",
  "reloaded-direct",
  "borrowed",
  "mutated-agent",
  "mutated-direct",
  "mutated-image",
  "mutated-tts",
] as const)("keeps the %s model, transport, and credential on its admitted owner", async (mode) => {
  const root = fs.realpathSync(roots.makeTempDir());
  const fixture = createColdPluginFixture({
    rootDir: root,
    providerId: "completion-fixture",
    manifest: {
      modelCatalog: {
        providers: {
          "completion-fixture": {
            defaultUtilityModel: "utility-alias",
            models: [
              { id: "canonical" },
              { id: "utility-canonical" },
              { id: "model-a" },
              { id: "model-b" },
            ],
          },
        },
      },
    },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = {
      id: ${JSON.stringify(fixture.pluginId)},
      register(api) {
        api.registerProvider({ id: "completion-fixture", label: "Fixture", auth: [],
          normalizeModelId({ modelId }) { return modelId === "hook-alias" ? "canonical" : modelId === "utility-alias" ? "utility-canonical" : modelId; }
        });
      }
    };`,
  );
  const wire: Array<{
    path: string | undefined;
    model: string;
    authorization: string | undefined;
  }> = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { model: string };
        wire.push({
          path: request.url,
          model: payload.model,
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            model: payload.model,
            choices: [
              { index: 0, delta: { content: "completion-owner-ok" }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    },
    async (baseUrl) => {
      const configPath = path.join(root, "config.json");
      const agentDir = path.join(root, "agent");
      const workspace = path.join(root, "workspace");
      fs.mkdirSync(workspace);
      const configFor = (owner: "a" | "b"): OpenClawConfig => ({
        agents: {
          defaults: {
            model: `completion-fixture/${mode.startsWith("reloaded") || mode === "borrowed" ? `model-${owner}` : mode === "agent" ? "hook-alias" : "canonical"}`,
            ...(mode === "utility-disabled" ? { utilityModel: "" } : {}),
            workspace,
            ...(mode === "tts-bare"
              ? { models: { "completion-fixture/canonical": { alias: "summary" } } }
              : {}),
          },
          entries: {
            main: {
              agentDir,
              workspace,
              ...(mode.includes("tts") ? { model: "completion-fixture/model-a" } : {}),
            },
          },
        },
        models: {
          providers: {
            "completion-fixture": {
              apiKey: `fixture-${owner}`,
              baseUrl: `${baseUrl}/${owner}/v1`,
              models: ["canonical", "utility-canonical", "model-a", "model-b"].map((id) => ({
                id,
                name: id,
                api: "openai-completions",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              })),
            },
          },
        },
        plugins: {
          allow: [fixture.pluginId],
          load: { paths: [root] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
        tts:
          mode === "tts-default" || mode === "reloaded-tts"
            ? {}
            : { summaryModel: mode === "tts-bare" ? "summary" : "completion-fixture/hook-alias" },
      });
      const cfg = configFor("a");
      const ttsConfig = resolveTtsConfig(cfg);
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          fs.writeFileSync(configPath, JSON.stringify(cfg));
          const borrowed =
            mode === "borrowed"
              ? await acquireAgentRunPreparedModelRuntime(
                  {
                    config: cfg,
                    agentId: "main",
                    agentDir,
                    workspaceDir: workspace,
                    loadRuntimePlugins: true,
                    runtimePluginSelections: [
                      { provider: "completion-fixture", modelId: "model-a", agentId: "main" },
                    ],
                  },
                  { catalogMode: "static" },
                )
              : undefined;
          try {
            if (mode.startsWith("reloaded") || borrowed) {
              await refreshPreparedModelRuntimeSnapshots(configFor("b"), {
                gatewayLifecycle: true,
                catalogMode: "static",
              });
            }
            if (mode.includes("tts")) {
              const pending = summarizeText({
                text: "A synthetic article.",
                targetLength: 100,
                cfg,
                config: ttsConfig,
                timeoutMs: 10_000,
              });
              if (mode === "mutated-tts") {
                ttsConfig.summaryModel = "completion-fixture/model-b";
              }
              expect((await pending).summary).toBe("completion-owner-ok");
            } else if (mode === "image" || mode === "mutated-image") {
              const request = {
                cfg,
                provider: "completion-fixture",
                model: mode === "image" ? "hook-alias" : "model-a",
                agentId: "main",
                agentDir,
                workspaceDir: workspace,
                timeoutMs: 10_000,
              };
              const image = {
                buffer: Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
                  "base64",
                ),
                mime: "image/png",
                fileName: "fixture.png",
              };
              const imagesRequest = { ...request, images: [image] };
              const pending =
                mode === "image"
                  ? describeImageWithModelCore({ ...request, ...image })
                  : describeImagesWithModelCore(imagesRequest);
              if (mode === "mutated-image") {
                imagesRequest.model = "model-b";
              }
              expect((await pending).text).toBe("completion-owner-ok");
            } else {
              const prepare = () => {
                if (mode === "mutated-agent") {
                  const request = {
                    cfg,
                    agentId: "main",
                    agentDir,
                    modelRef: "completion-fixture/model-a",
                  };
                  const pending = acquireSimpleCompletionModelForAgent(request);
                  request.modelRef = "completion-fixture/model-b";
                  return pending;
                }
                if (mode === "mutated-direct") {
                  const request = {
                    cfg,
                    agentId: "main",
                    agentDir,
                    provider: "completion-fixture",
                    modelId: "model-a",
                  };
                  const pending = prepareSimpleCompletionModel(request);
                  request.modelId = "model-b";
                  return pending;
                }
                return mode === "reloaded-direct" || borrowed
                  ? prepareSimpleCompletionModel({
                      cfg,
                      agentId: "main",
                      agentDir,
                      provider: "completion-fixture",
                      modelId: "model-a",
                      ...(borrowed ? { preparedModelRuntime: borrowed.snapshot } : {}),
                    })
                  : acquireSimpleCompletionModelForAgent({
                      cfg,
                      agentId: "main",
                      agentDir,
                      useUtilityModel: mode.startsWith("utility"),
                    });
              };
              const prepared = await prepare();
              try {
                if ("error" in prepared) {
                  throw new Error(prepared.error);
                }
                const result = await completeWithPreparedSimpleCompletionModel({
                  model: prepared.model,
                  auth: prepared.auth,
                  assertCurrent: "assertCurrent" in prepared ? prepared.assertCurrent : undefined,
                  cfg,
                  context: {
                    messages: [
                      { role: "user", content: "Reply with the fixture marker.", timestamp: 1 },
                    ],
                  },
                });
                expect(result.content).toEqual([{ type: "text", text: "completion-owner-ok" }]);
              } finally {
                if ("release" in prepared) {
                  prepared.release();
                }
              }
            }
            const owner = mode.startsWith("reloaded") ? "b" : "a";
            const model =
              mode === "reloaded-agent" || mode === "reloaded-tts"
                ? "model-b"
                : mode === "reloaded-direct" ||
                    (mode.startsWith("mutated") && mode !== "mutated-tts") ||
                    borrowed
                  ? "model-a"
                  : mode === "utility"
                    ? "utility-canonical"
                    : "canonical";
            expect(wire).toEqual([
              {
                path: `/${owner}/v1/chat/completions`,
                model,
                authorization: `Bearer fixture-${owner}`,
              },
            ]);
          } finally {
            borrowed?.release();
          }
        },
      );
    },
  );
});
