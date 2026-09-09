// Windows integration coverage for host-local file URLs through registered media tools.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as imageGenerationRuntime from "../../image-generation/runtime.js";
import * as mediaStore from "../../media/store.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  FAKE_PDF_MEDIA,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: vi.fn(),
}));

vi.mock("../openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2N5sAAAAASUVORK5CYII=",
  "base64",
);

function requireTool(tools: ReturnType<typeof createOpenClawTools>, name: "view_image" | "pdf") {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `${name} tool registration`).toBeDefined();
  if (!tool) {
    throw new Error(`expected registered ${name} tool`);
  }
  return tool;
}

describe.runIf(process.platform === "win32")("host-local media tool file URLs", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads Unicode and space file URLs through registered image and PDF tools", async () => {
    const startedAt = performance.now();
    let lastStage = "agent-dir:before";
    let failureRecorded = false;
    const recordStage = (stage: string) => {
      lastStage = stage;
      console.log(
        `[windows-media-phase] ${JSON.stringify({
          stage,
          elapsedMs: Math.round(performance.now() - startedAt),
        })}`,
      );
    };
    // Capture the original failure before either cleanup can replace it.
    const recordFailure = (error: unknown): never => {
      if (!failureRecorded) {
        failureRecorded = true;
        const name = error instanceof Error ? error.name : undefined;
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        console.error(
          `[windows-media-phase] ${JSON.stringify({
            stage: lastStage,
            elapsedMs: Math.round(performance.now() - startedAt),
            errorName:
              typeof name === "string" && name.length <= 64 && /^(?:[A-Z][a-z]*)*Error$/.test(name)
                ? name
                : "UnknownError",
            errorCode:
              typeof code === "string" && /^E[A-Z0-9_]{1,63}$/.test(code) ? code : "unavailable",
          })}`,
        );
      }
      throw error;
    };

    recordStage("agent-dir:before");
    await withTempPdfAgentDir(async (agentDir) => {
      recordStage("agent-dir:callback");
      try {
        recordStage("workspace-dir:before");
        const workspaceDir = await fs
          .mkdtemp(path.join(os.tmpdir(), "openclaw-media-file-url-Å "))
          .catch(recordFailure);
        recordStage("workspace-dir:after");
        try {
          const imagePath = path.join(workspaceDir, "café image.png");
          const pdfPath = path.join(workspaceDir, "résumé document.pdf");
          recordStage("image-fixture:before");
          await fs.writeFile(imagePath, ONE_PIXEL_PNG);
          recordStage("image-fixture:after");
          recordStage("pdf-fixture:before");
          await fs.writeFile(pdfPath, FAKE_PDF_MEDIA.buffer);
          recordStage("pdf-fixture:after");
          recordStage("pdf-stub:before");
          await stubPdfToolInfra(agentDir, {
            mockLoad: false,
            provider: "anthropic",
            input: ["text", "document"],
          });
          recordStage("pdf-stub:after");
          vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");

          const config: OpenClawConfig = {
            agents: {
              entries: { main: { default: true } },
              defaults: { pdfModel: { primary: "anthropic/claude-opus-4-6" } },
            },
          } as OpenClawConfig;
          recordStage("tool-factory:before");
          const tools = createOpenClawTools({
            agentDir,
            workspaceDir,
            config,
            modelHasVision: true,
            disableMessageTool: true,
            disablePluginTools: true,
            wrapBeforeToolCallHook: false,
            recordToolPrepStage: recordStage,
          });
          recordStage("tool-factory:after");

          const imageUrl = pathToFileURL(imagePath).href;
          recordStage("image-execute:before");
          const imageResult = await requireTool(tools, "view_image").execute("image-call", {
            path: imageUrl,
          });
          recordStage("image-execute:after");
          expect(imageResult.content).toEqual([
            {
              type: "text",
              text: "Loaded 1 image into private model context for inspection; not displayed, attached, or sent to the user.",
            },
            expect.objectContaining({ type: "image" }),
          ]);

          recordStage("pdf-execute:before");
          const pdfResult = await requireTool(tools, "pdf").execute("pdf-call", {
            pdf: pathToFileURL(pdfPath).href,
            prompt: "summarize",
          });
          recordStage("pdf-execute:after");
          expect(pdfResult.content).toEqual([{ type: "text", text: "native summary" }]);
          expect(pdfResult.details).toMatchObject({ pdf: pdfPath, native: true });

          vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
            {
              id: "fixture",
              defaultModel: "edit",
              models: ["edit"],
              isConfigured: () => true,
              capabilities: {
                generate: { maxCount: 1 },
                edit: { enabled: true, maxInputImages: 1 },
                geometry: {},
              },
              generateImage: vi.fn(async () => {
                throw new Error("runtime generateImage spy should own the call");
              }),
            },
          ]);
          const generateImage = vi
            .spyOn(imageGenerationRuntime, "generateImage")
            .mockResolvedValue({
              provider: "fixture",
              model: "edit",
              attempts: [],
              ignoredOverrides: [],
              images: [{ buffer: ONE_PIXEL_PNG, mimeType: "image/png", fileName: "edited.png" }],
            });
          vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
            path: path.join(workspaceDir, "edited.png"),
            id: "edited.png",
            size: ONE_PIXEL_PNG.length,
            contentType: "image/png",
          });
          recordStage("image-generation-factory:before");
          const generationTool = createImageGenerateTool({
            agentDir,
            workspaceDir,
            config: {
              agents: {
                defaults: {
                  mediaModels: { image: { primary: "fixture/edit" } },
                },
              },
            },
          });
          recordStage("image-generation-factory:after");
          expect(generationTool?.name).toBe("image_generate");
          if (!generationTool) {
            throw new Error("expected image_generate tool");
          }
          recordStage("image-generation-execute:before");
          await generationTool.execute("generation-call", {
            prompt: "edit the reference",
            image: imageUrl,
          });
          recordStage("image-generation-execute:after");
          expect(generateImage.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
              inputImages: [expect.objectContaining({ buffer: ONE_PIXEL_PNG })],
            }),
          );
        } catch (error) {
          recordFailure(error);
        } finally {
          recordStage("workspace-cleanup:before");
          await fs.rm(workspaceDir, { recursive: true, force: true }).catch(recordFailure);
          recordStage("workspace-cleanup:after");
        }
      } finally {
        recordStage("agent-cleanup:before");
      }
    })
      .catch(recordFailure)
      .finally(() => recordStage("agent-dir:settled"));
  });
});
