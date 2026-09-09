import { AsyncLocalStorage } from "node:async_hooks";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Model-backed image understanding runtime for providers without a native media
// provider hook.
import { minimaxUnderstandImage } from "../agents/minimax-vlm.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import {
  getModelProviderRequestRouteFacts,
  type ModelProviderRequestTransportOverrides,
} from "../agents/provider-request-config.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../agents/provider-secret-egress.js";
import { registerProviderStreamForModel } from "../agents/provider-stream.js";
import {
  coerceImageAssistantText,
  hasImageReasoningOnlyResponse,
} from "../agents/tools/image-tool.helpers.js";
import { complete } from "../llm/stream.js";
import type { AssistantMessage, Context, Model, ProviderStreamOptions } from "../llm/types.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveImageRuntime, resolveImageRuntimeForModel } from "./image-model-runtime.js";
import type {
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
} from "./types.js";

function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens = 4096) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

function isNativeResponsesReasoningPayload(model: Model): boolean {
  if (
    model.api !== "openai-responses" &&
    model.api !== "azure-openai-responses" &&
    model.api !== "openai-chatgpt-responses"
  ) {
    return false;
  }
  return resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "image",
    transport: "media-understanding",
    providerMetadataOwners: getModelProviderRequestRouteFacts(model)?.providerMetadataOwners,
  }).usesKnownNativeOpenAIRoute;
}

function removeReasoningInclude(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const next = value.filter((entry) => entry !== "reasoning.encrypted_content");
  return next.length > 0 ? next : undefined;
}

function disableReasoningForImageRetryPayload(payload: unknown, model: Model): unknown {
  // Empty-text image responses can be caused by reasoning-only payloads; retry
  // with reasoning stripped while preserving provider-specific Responses shape.
  if (!isRecord(payload)) {
    return undefined;
  }
  const next = { ...payload };
  delete next.reasoning;
  delete next.reasoning_effort;

  const include = removeReasoningInclude(next.include);
  if (include === undefined) {
    delete next.include;
  } else {
    next.include = include;
  }

  if (isNativeResponsesReasoningPayload(model)) {
    next.reasoning = { effort: "none" };
  }
  return next;
}

function isImageModelNoTextError(err: unknown): boolean {
  return err instanceof Error && /^Image model returned no text\b/.test(err.message);
}

function composeImageDescriptionPayloadHandlers(
  first: ProviderStreamOptions["onPayload"] | undefined,
  second: ProviderStreamOptions["onPayload"] | undefined,
): ProviderStreamOptions["onPayload"] | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return (payload, payloadModel) => {
    const runSecond = (firstResult: unknown) => {
      const nextPayload = firstResult === undefined ? payload : firstResult;
      const secondResult = second(nextPayload, payloadModel);
      const coerceResult = (resolvedSecond: unknown) =>
        resolvedSecond === undefined ? firstResult : resolvedSecond;
      return isPromiseLike(secondResult)
        ? Promise.resolve(secondResult).then(coerceResult)
        : coerceResult(secondResult);
    };
    const firstResult = first(payload, payloadModel);
    if (isPromiseLike(firstResult)) {
      return Promise.resolve(firstResult).then(runSecond);
    }
    return runSecond(firstResult);
  };
}

function buildImageContext(
  prompt: string,
  images: Array<{ buffer: Buffer; mime?: string }>,
  opts?: { promptInUserContent?: boolean },
): Context {
  const imageContent = images.map((image) => ({
    type: "image" as const,
    data: image.buffer.toString("base64"),
    mimeType: image.mime ?? "image/jpeg",
  }));
  const content = opts?.promptInUserContent
    ? [{ type: "text" as const, text: prompt }, ...imageContent]
    : imageContent;

  return {
    ...(opts?.promptInUserContent ? {} : { systemPrompt: prompt }),
    messages: [
      {
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ],
  };
}

function shouldPlaceImagePromptInUserContent(model: Model): boolean {
  // GitHub Copilot models (including Gemini 3.1 Pro Preview) require the
  // prompt text to be in the user message alongside the image. Placing it
  // in a separate system message produces "Request must contain at least
  // one non-empty message" (400).
  if (model.provider === "github-copilot") {
    return true;
  }
  const capabilities = resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "image",
    transport: "media-understanding",
    providerMetadataOwners: getModelProviderRequestRouteFacts(model)?.providerMetadataOwners,
  });
  return (
    capabilities.endpointClass === "openrouter" ||
    capabilities.endpointClass === "modelstudio-native" ||
    (model.provider.toLowerCase() === "openrouter" && capabilities.endpointClass === "default")
  );
}

function buildImageRequestHeaders(model: Model): Record<string, string> | undefined {
  if (model.provider !== "github-copilot") {
    return undefined;
  }
  return {
    "x-initiator": "user",
    "Copilot-Vision-Request": "true",
  };
}

async function describeImagesWithMinimax(params: {
  runtimeValue: string;
  provider: string;
  modelId: string;
  modelBaseUrl?: string;
  prompt: string;
  timeoutMs?: number;
  images: Array<{ buffer: Buffer; mime?: string }>;
  allowPrivateNetwork?: boolean;
  request?: ModelProviderRequestTransportOverrides;
  signal?: AbortSignal;
  assertResourcesOpen?: () => void;
}): Promise<ImagesDescriptionResult> {
  const responses: string[] = [];
  // MiniMax VLM handles its own outbound fetch, so unwrap only at this final handoff.
  const runtimeValue = unwrapSecretSentinelsForProviderEgress(
    params.runtimeValue,
    "MiniMax VLM request",
  );
  const apiKey = runtimeValue;
  for (const [index, image] of params.images.entries()) {
    // One MiniMax request is issued per image, so cancellation must gate every
    // iteration or a dead run can continue buying calls after the first image.
    params.signal?.throwIfAborted();
    params.assertResourcesOpen?.();
    const prompt =
      params.images.length > 1
        ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
        : params.prompt;
    const text = await minimaxUnderstandImage({
      apiKey,
      provider: params.provider,
      prompt,
      imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      modelBaseUrl: params.modelBaseUrl,
      timeoutMs: params.timeoutMs,
      allowPrivateNetwork: params.allowPrivateNetwork,
      request: params.request,
      signal: params.signal,
    });
    responses.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
  }
  return {
    text: responses.join("\n\n").trim(),
    model: params.modelId,
  };
}

function resolveImageDescriptionTimeoutMs(timeoutMs: number | undefined) {
  return clampPositiveTimerTimeoutMs(timeoutMs);
}

function buildImageDescriptionTimeoutError(params: {
  phase: "setup" | "request";
  timeoutMs: number;
  setupDurationMs?: number;
}): Error {
  if (params.phase === "setup") {
    return new Error(
      `image description setup timed out after ${params.timeoutMs}ms before provider request started`,
    );
  }
  const setupDurationMs =
    typeof params.setupDurationMs === "number" && Number.isFinite(params.setupDurationMs)
      ? Math.max(0, Math.floor(params.setupDurationMs))
      : 0;
  return new Error(
    setupDurationMs > 0
      ? `image description request timed out after ${params.timeoutMs}ms (setup took ${setupDurationMs}ms before provider request started)`
      : `image description request timed out after ${params.timeoutMs}ms`,
  );
}

async function withImageDescriptionTimeout<T>(params: {
  task: Promise<T>;
  timeoutMs: number | undefined;
  controller: AbortController;
  signal?: AbortSignal;
  createTimeoutError: (timeoutMs: number) => Error;
}): Promise<T> {
  params.signal?.throwIfAborted();
  if (params.timeoutMs === undefined && !params.signal) {
    return await params.task;
  }
  let timeout: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  const races: Promise<T>[] = [params.task];
  if (params.timeoutMs !== undefined) {
    races.push(
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          params.controller.abort();
          reject(params.createTimeoutError(params.timeoutMs!));
        }, params.timeoutMs);
      }),
    );
  }
  if (params.signal) {
    races.push(
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          try {
            params.signal?.throwIfAborted();
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("image description aborted", { cause: error }),
            );
          }
        };
        params.signal?.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => params.signal?.removeEventListener("abort", onAbort);
        if (params.signal?.aborted) {
          onAbort();
        }
      }),
    );
  }
  try {
    return await Promise.race(races);
  } finally {
    removeAbortListener?.();
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function describeImagesWithModelInternal(
  request: ImagesDescriptionRequest,
  options: {
    onPayload?: ProviderStreamOptions["onPayload"];
    resolveRuntime: typeof resolveImageRuntime;
  },
): Promise<ImagesDescriptionResult> {
  // Multi-image callers may retain their request object while setup awaits admission.
  const params = { ...request };
  const reported = createDeferredCore<ImagesDescriptionResult>();
  const parentSignal = getAsyncWorkSignal();
  // Admit drainage before setup; reporting a deadline does not settle provider work.
  void trackAsyncWork(async () => {
    const work = new AsyncWorkScope();
    const runInScope = work.run(() => AsyncLocalStorage.snapshot());
    const closeWork = () => runInScope(() => work.beginClose(parentSignal?.reason));
    parentSignal?.addEventListener("abort", closeWork, { once: true });
    if (parentSignal?.aborted) {
      closeWork();
    }
    let releaseRuntime: (() => void) | undefined;
    let assertResourcesOpen: (() => void) | undefined;
    try {
      reported.resolve(
        await work.track(async () => {
          const prompt = params.prompt ?? "Describe the image.";
          params.signal?.throwIfAborted();
          const startedAtMs = Date.now();
          const controller = new AbortController();
          const requestSignal = params.signal
            ? AbortSignal.any([params.signal, controller.signal])
            : controller.signal;
          const configuredTimeoutMs = resolveImageDescriptionTimeoutMs(params.timeoutMs);
          const resolutionTask = work.track(() =>
            options.resolveRuntime({ ...params, signal: requestSignal }, (resources) => {
              releaseRuntime = resources.release;
              assertResourcesOpen = resources.assertResourcesOpen;
            }),
          );
          const resolved = await withImageDescriptionTimeout({
            controller,
            signal: params.signal,
            timeoutMs: configuredTimeoutMs,
            createTimeoutError: (timeoutMs) =>
              buildImageDescriptionTimeoutError({ phase: "setup", timeoutMs }),
            task: resolutionTask,
          });
          params.signal?.throwIfAborted();
          assertResourcesOpen?.();
          const setupDurationMs = Date.now() - startedAtMs;

          if (resolved.kind === "minimax") {
            return await describeImagesWithMinimax({
              ...resolved,
              assertResourcesOpen,
              prompt,
              timeoutMs: params.timeoutMs,
              images: params.images,
              signal: requestSignal,
            });
          }

          const { model, runtimeValue: apiKey } = resolved;
          // Prepared auth may carry sentinel-protected request headers. Resolve them only at this
          // final direct-completion boundary so provider SDKs never receive sentinel placeholders.
          const requestModel = unwrapModelHeaderSentinelsForProviderEgress(
            model,
            "image description provider request",
          );
          const providerStreamFn = registerProviderStreamForModel({
            model: requestModel,
            cfg: resolved.cfg,
            agentDir: resolved.agentDir,
            wrapProviderStream: true,
            capability: "image",
            ...(resolved.workspaceDir ? { workspaceDir: resolved.workspaceDir } : {}),
          });
          const context = buildImageContext(prompt, params.images, {
            promptInUserContent: shouldPlaceImagePromptInUserContent(model),
          });
          const maxTokens = resolveImageToolMaxTokens(model.maxTokens, params.maxTokens);
          const completeImage = async (onPayload?: ProviderStreamOptions["onPayload"]) => {
            params.signal?.throwIfAborted();
            assertResourcesOpen?.();
            const payloadHandler = composeImageDescriptionPayloadHandlers(
              onPayload,
              options.onPayload,
            );
            const timeoutMs = configuredTimeoutMs;
            const headers = buildImageRequestHeaders(requestModel);
            const streamOptions = {
              apiKey,
              maxTokens,
              signal: requestSignal,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(headers ? { headers } : {}),
              ...(payloadHandler ? { onPayload: payloadHandler } : {}),
            };
            const task: Promise<AssistantMessage> = work.track(() =>
              providerStreamFn
                ? (async () =>
                    await (await providerStreamFn(requestModel, context, streamOptions)).result())()
                : complete(requestModel, context, streamOptions),
            );
            return await withImageDescriptionTimeout({
              controller,
              signal: params.signal,
              timeoutMs,
              createTimeoutError: (requestTimeoutMs) =>
                buildImageDescriptionTimeoutError({
                  phase: "request",
                  timeoutMs: requestTimeoutMs,
                  setupDurationMs,
                }),
              task,
            });
          };
          const message = await completeImage();
          try {
            const text = coerceImageAssistantText({
              message,
              provider: model.provider,
              model: model.id,
            });
            return { text, model: model.id };
          } catch (err) {
            if (!isImageModelNoTextError(err) || !hasImageReasoningOnlyResponse(message)) {
              throw err;
            }
          }
          params.signal?.throwIfAborted();
          const retryMessage = await completeImage(disableReasoningForImageRetryPayload);
          const text = coerceImageAssistantText({
            message: retryMessage,
            provider: model.provider,
            model: model.id,
          });
          return { text, model: model.id };
        }),
      );
    } catch (error) {
      reported.reject(error);
    } finally {
      await work.runWhenIdle(() => undefined);
      await runInScope(() => work.drain());
      parentSignal?.removeEventListener("abort", closeWork);
      releaseRuntime?.();
    }
  }).catch((error: unknown) => reported.reject(error));
  return await reported.promise;
}

function toImagesDescriptionRequest(params: ImageDescriptionRequest): ImagesDescriptionRequest {
  return {
    images: [
      {
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.mime,
      },
    ],
    model: params.model,
    provider: params.provider,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    profile: params.profile,
    preferredProfile: params.preferredProfile,
    authStore: params.authStore,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.preparedModelRuntime ? { preparedModelRuntime: params.preparedModelRuntime } : {}),
    cfg: params.cfg,
  };
}

function createImageDescriptions(resolveRuntime: typeof resolveImageRuntime) {
  const describe = (
    params: ImagesDescriptionRequest,
    onPayload?: ProviderStreamOptions["onPayload"],
  ) => describeImagesWithModelInternal(params, { onPayload, resolveRuntime });
  return {
    single: (params: ImageDescriptionRequest) => describe(toImagesDescriptionRequest(params)),
    multiple: (params: ImagesDescriptionRequest) => describe(params),
    singleWithPayload: (
      params: ImageDescriptionRequest,
      onPayload: ProviderStreamOptions["onPayload"],
    ) => describe(toImagesDescriptionRequest(params), onPayload),
    multipleWithPayload: (
      params: ImagesDescriptionRequest,
      onPayload: ProviderStreamOptions["onPayload"],
    ) => describe(params, onPayload),
  };
}

export const {
  single: describeImageWithModelCore,
  multiple: describeImagesWithModelCore,
  singleWithPayload: describeImageWithModelPayloadTransformCore,
  multipleWithPayload: describeImagesWithModelPayloadTransformCore,
} = createImageDescriptions(resolveImageRuntime);

// Internal fallback candidates have already consumed input normalization.
export const {
  single: describeImageWithResolvedModelCore,
  multiple: describeImagesWithResolvedModelCore,
} = createImageDescriptions(resolveImageRuntimeForModel);
