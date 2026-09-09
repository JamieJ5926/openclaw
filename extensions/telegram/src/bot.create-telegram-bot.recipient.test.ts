import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  telegramBotInfoForTest,
  type TelegramIngestGroupForTest,
  type TelegramMentionPolicyForTest,
} from "./bot.create-telegram-bot.test-support.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

const saveRemoteMedia = vi.fn();
const rootRead = vi.fn();
const { triggerInternalHookMock } = vi.hoisted(() => ({
  triggerInternalHookMock: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    triggerInternalHook: triggerInternalHookMock,
  };
});

vi.mock("openclaw/plugin-sdk/file-access-runtime", () => ({
  root: async (rootDir: string) => ({
    read: async (relativePath: string, options?: { maxBytes?: number }) =>
      await rootRead({ rootDir, relativePath, maxBytes: options?.maxBytes }),
  }),
}));

vi.mock("./telegram-media.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-media.runtime.js")>();
  return {
    ...actual,
    saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
  };
});

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage: async () => null,
}));

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const {
  getChatSpy,
  getLoadConfigMock,
  getOnHandler,
  replySpy,
  sendMessageSpy,
  telegramBotDepsForTest,
} = harness;
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const { MediaFetchError } = await import("./telegram-media.runtime.js");
const { runWithTelegramSpooledReplayUpdate } = await import("./bot-processing-outcome.js");

let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;
const TEXT_FRAGMENT_COALESCE_TEST_GAP_MS = 5_000;

function resolveFlushTimerForDelay(setTimeoutSpy: ReturnType<typeof vi.spyOn>, delayMs: number) {
  const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
    (call: Parameters<typeof setTimeout>) => call[1] === delayMs,
  );
  const flushTimer =
    flushTimerCallIndex >= 0
      ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
      : undefined;
  if (flushTimerCallIndex >= 0) {
    clearTimeout(
      setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
    );
  }
  return flushTimer;
}

async function flushChannelPostMediaGroup(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  completionTimeoutMs = 75,
  delayMs: number = TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
) {
  const flushTimer = resolveFlushTimerForDelay(setTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
  let completion: Promise<unknown> | undefined;
  try {
    // These timers synchronously admit work, then discard the real queue promise.
    flushTimer?.();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const queued = enqueueSpy.mock.results[0];
    if (queued?.type === "return") {
      completion = queued.value;
    }
  } finally {
    enqueueSpy.mockRestore();
  }
  expect(completion).toBeDefined();
  await withTimeout(Promise.resolve(completion), completionTimeoutMs, {
    message: `Telegram buffered flush for the ${delayMs} ms timer did not complete`,
  });
}

function replyPayload(): Record<string, unknown> {
  const call = replySpy.mock.calls.at(0);
  if (!call || !call[0] || typeof call[0] !== "object") {
    throw new Error("Expected reply payload");
  }
  return call[0] as Record<string, unknown>;
}

function setTelegramIngestGroupConfig(
  params: {
    groups?: Record<string, TelegramIngestGroupForTest>;
    groupAllowFrom?: string[];
    providerPolicy?: TelegramMentionPolicyForTest;
    accountPolicy?: TelegramMentionPolicyForTest;
    customMentionPatterns?: boolean;
  } = {},
) {
  loadConfig.mockReturnValue({
    ...(params.customMentionPatterns
      ? { messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } } }
      : {}),
    channels: {
      telegram: {
        groupPolicy: "open",
        ...(params.groupAllowFrom ? { groupAllowFrom: params.groupAllowFrom } : {}),
        ...(params.providerPolicy ? { mentionPatterns: params.providerPolicy } : {}),
        groups: params.groups ?? { "-100456": { requireMention: true, ingest: true } },
        ...(params.accountPolicy
          ? { accounts: { work: { mentionPatterns: params.accountPolicy } } }
          : {}),
      },
    },
  });
}

async function dispatchTelegramGroupPhoto(params: {
  messageId: number;
  topicId?: number;
  albumId?: string;
  caption?: string;
  extraMessage?: Record<string, unknown>;
  getFile?: () => Promise<{ file_path: string }>;
}) {
  const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  await handler({
    message: {
      chat: {
        id: -100456,
        type: "supergroup",
        title: "Ops Chat",
        is_forum: params.topicId !== undefined,
      },
      message_id: params.messageId,
      date: 1736380800,
      ...(params.topicId ? { message_thread_id: params.topicId, is_topic_message: true } : {}),
      ...(params.albumId ? { media_group_id: params.albumId } : {}),
      ...(params.caption ? { caption: params.caption } : {}),
      ...params.extraMessage,
      photo: [{ file_id: `photo-${params.messageId}` }],
      from: { id: 55, is_bot: false, first_name: "u" },
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: params.getFile ?? (async () => ({ file_path: `photos/${params.messageId}.jpg` })),
  });
}

function createTelegramGroupTextContext(params: {
  messageId: number;
  text: string;
  extraMessage?: Record<string, unknown>;
}) {
  return {
    message: {
      chat: { id: -100456, type: "supergroup", title: "Ops Chat" },
      message_id: params.messageId,
      date: 1736380800,
      text: params.text,
      ...params.extraMessage,
      from: { id: 55, is_bot: false, first_name: "u" },
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: async () => ({}),
  };
}

describe("createTelegramBot recipient routing", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        botInfo: telegramBotInfoForTest,
        telegramTransport: {
          fetch: globalThis.fetch,
          sourceFetch: globalThis.fetch,
          close: async () => {},
        },
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  beforeEach(() => {
    setTelegramRuntime({
      state: {
        openKeyedStore: ((options) =>
          createPluginStateKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openKeyedStore"],
        openSyncKeyedStore: ((options) =>
          createPluginStateSyncKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
    triggerInternalHookMock.mockClear();
    saveRemoteMedia.mockReset();
    saveRemoteMedia.mockImplementation(
      async (params: { fetchImpl: typeof fetch; maxBytes: number; url: string }) => {
        const response = await params.fetchImpl(params.url);
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.length > params.maxBytes) {
          throw new MediaFetchError("max_bytes", `payload exceeds maxBytes ${params.maxBytes}`);
        }
        return {
          path: "/tmp/telegram-media.bin",
          contentType: response.headers.get("content-type"),
        };
      },
    );
    rootRead.mockReset();
  });

  it.each([
    {
      messageId: 143001,
      firstRecipient: "other_bot",
      continuation: "@openclaw_bot inspect this",
      admitted: "second",
    },
    {
      messageId: 143003,
      firstRecipient: "openclaw_bot",
      continuation: " plain continuation",
      admitted: "combined",
    },
  ] as const)(
    "keeps long @$firstRecipient messages routed through the fragment buffer",
    async ({ messageId, firstRecipient, continuation, admitted }) => {
      setTelegramIngestGroupConfig({ groups: { "-100456": { requireMention: true } } });
      getChatSpy.mockResolvedValue({ id: 1000, type: "private", first_name: "Other" });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        createTelegramBot({
          token: "tok",
          testTimings: {
            ...TELEGRAM_TEST_TIMINGS,
            textFragmentGapMs: TEXT_FRAGMENT_COALESCE_TEST_GAP_MS,
          },
        });
        const handler = getOnHandler("message");
        const firstText = `@${firstRecipient} ${"A".repeat(4050)}`;
        await handler(
          createTelegramGroupTextContext({
            messageId,
            text: firstText,
            extraMessage: {
              entities: [{ type: "mention", offset: 0, length: firstRecipient.length + 1 }],
            },
          }),
        );
        await handler(
          createTelegramGroupTextContext({
            messageId: messageId + 1,
            text: continuation,
            extraMessage:
              admitted === "second"
                ? { entities: [{ type: "mention", offset: 0, length: "@openclaw_bot".length }] }
                : undefined,
          }),
        );
        if (
          setTimeoutSpy.mock.calls.some(([, delay]) => delay === TEXT_FRAGMENT_COALESCE_TEST_GAP_MS)
        ) {
          await flushChannelPostMediaGroup(
            setTimeoutSpy,
            1_075,
            TEXT_FRAGMENT_COALESCE_TEST_GAP_MS,
          );
        }

        expect(replySpy).toHaveBeenCalledOnce();
        expect(replyPayload().RawBody).toBe(
          admitted === "second" ? continuation : firstText + continuation,
        );
      } finally {
        setTimeoutSpy.mockRestore();
        getChatSpy.mockReset().mockResolvedValue(undefined);
      }
    },
  );

  it.each([true, false])(
    "keeps a native self mention with plain debounced text (self first=%s)",
    async (selfFirst) => {
      loadConfig.mockReturnValue({
        messages: { inbound: { debounceMs: 25 } },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "-100456": { requireMention: true } },
          },
        },
      });
      vi.useFakeTimers();
      try {
        createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
        const handler = getOnHandler("message");
        const addressed = {
          text: selfFirst ? "@openclaw_bot inspect this" : "Assistant inspect this",
          extraMessage: {
            entities: [
              selfFirst
                ? { type: "mention", offset: 0, length: "@openclaw_bot".length }
                : {
                    type: "text_mention",
                    offset: 0,
                    length: "Assistant".length,
                    user: { id: 999, is_bot: true, first_name: "OpenClaw" },
                  },
            ],
          },
        };
        const plain = { text: "plain continuation" };
        const messages = selfFirst ? [addressed, plain] : [plain, addressed];
        for (const [index, message] of messages.entries()) {
          await handler(
            createTelegramGroupTextContext({
              messageId: (selfFirst ? 143050 : 143052) + index,
              ...message,
            }),
          );
        }
        expect(replySpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(25);
        expect(replySpy).toHaveBeenCalledOnce();
        expect(replyPayload().RawBody).toBe(messages.map((message) => message.text).join("\n"));
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it("keeps buffered work when an authorized stop replies to another bot", async () => {
    setTelegramIngestGroupConfig({
      groups: { "-100456": { requireMention: true } },
      groupAllowFrom: ["55"],
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({
        token: "tok",
        testTimings: {
          ...TELEGRAM_TEST_TIMINGS,
          textFragmentGapMs: TEXT_FRAGMENT_COALESCE_TEST_GAP_MS,
        },
      });
      const handler = getOnHandler("message");
      const text = `@openclaw_bot ${"A".repeat(4050)}`;
      const context = createTelegramGroupTextContext({
        messageId: 143030,
        text,
        extraMessage: {
          entities: [{ type: "mention", offset: 0, length: "@openclaw_bot".length }],
        },
      });
      const update = { update_id: 143030, message: context.message };
      const { deferredWork } = await runWithTelegramSpooledReplayUpdate(update, () =>
        handler({ ...context, update }),
      );
      expect(deferredWork).toBeDefined();
      if (!deferredWork) {
        throw new Error("Expected buffered Telegram replay participant");
      }
      await handler(
        createTelegramGroupTextContext({
          messageId: 143031,
          text: "stop",
          extraMessage: {
            reply_to_message: {
              message_id: 98,
              text: "another bot's reply",
              from: { id: 1000, is_bot: true, first_name: "Other" },
            },
          },
        }),
      );

      expect(deferredWork.isSettled()).toBe(false);
      await flushChannelPostMediaGroup(setTimeoutSpy, 1_075, TEXT_FRAGMENT_COALESCE_TEST_GAP_MS);
      await expect(deferredWork.task).resolves.toEqual({ kind: "completed" });
      expect(replySpy).toHaveBeenCalledOnce();
      expect(replyPayload().RawBody).toBe(text);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each([false, true])(
    "routes replies to another bot with explicit self mention=%s",
    async (mentionsSelf) => {
      setTelegramIngestGroupConfig({ groups: { "-100456": { requireMention: false } } });
      createTelegramBot({ token: "tok" });
      const text = mentionsSelf ? "@openclaw_bot inspect this" : "inspect this";
      await getOnHandler("message")(
        createTelegramGroupTextContext({
          messageId: mentionsSelf ? 143006 : 143005,
          text,
          extraMessage: {
            ...(mentionsSelf
              ? { entities: [{ type: "mention", offset: 0, length: "@openclaw_bot".length }] }
              : {}),
            reply_to_message: {
              message_id: 99,
              text: "another bot's reply",
              from: { id: 1000, is_bot: true, first_name: "Other" },
            },
          },
        }),
      );

      expect(replySpy).toHaveBeenCalledTimes(Number(mentionsSelf));
      expect(sendMessageSpy).not.toHaveBeenCalled();
      if (mentionsSelf) {
        expect(replyPayload().RawBody).toBe(text);
      }
    },
  );

  it.each([
    { messageId: 143040, album: false, surface: "photo" },
    { messageId: 143042, album: true, surface: "album" },
  ])("accepts a self text mention in a $surface caption", async ({ messageId, album }) => {
    setTelegramIngestGroupConfig({ groups: { "-100456": { requireMention: true } } });
    const getFile = vi.fn(async () => {
      throw new Error("Bad Request: file is too big");
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const caption = "OpenClaw inspect this";
      await dispatchTelegramGroupPhoto({
        messageId,
        ...(album ? { albumId: `self-bot-album-${messageId}` } : {}),
        caption,
        extraMessage: {
          caption_entities: [
            {
              type: "text_mention",
              offset: 0,
              length: "OpenClaw".length,
              user: { id: 999, is_bot: true, first_name: "OpenClaw" },
            },
          ],
        },
        getFile,
      });
      if (album) {
        await dispatchTelegramGroupPhoto({
          messageId: messageId + 1,
          albumId: `self-bot-album-${messageId}`,
          getFile,
        });
        await flushChannelPostMediaGroup(setTimeoutSpy);
      }

      expect(getFile).toHaveBeenCalledTimes(album ? 2 : 1);
      expect(sendMessageSpy).toHaveBeenCalledOnce();
      expect(replySpy).toHaveBeenCalledOnce();
      expect(replyPayload().RawBody).toBe(caption);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each([
    {
      messageId: 143010,
      surface: "photo",
      album: false,
      failure: "download failure",
      error: "Bad Request: wrong file identifier",
    },
    {
      messageId: 143012,
      surface: "photo",
      album: false,
      failure: "oversized file",
      error: "Bad Request: file is too big",
    },
    {
      messageId: 143014,
      surface: "album",
      album: true,
      failure: "download failure",
      error: "Bad Request: wrong file identifier",
    },
    {
      messageId: 143016,
      surface: "album",
      album: true,
      failure: "oversized file",
      error: "Bad Request: file is too big",
    },
  ])(
    "does not warn about another bot's $surface after $failure",
    async ({ messageId, album, error }) => {
      setTelegramIngestGroupConfig({ groups: { "-100456": { requireMention: false } } });
      getChatSpy.mockResolvedValue({ id: 1000, type: "private", first_name: "Other" });
      const getFile = vi.fn(async () => {
        throw new Error(error);
      });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
        await dispatchTelegramGroupPhoto({
          messageId,
          ...(album ? { albumId: `other-bot-album-${messageId}` } : {}),
          caption: "@other_bot inspect this",
          extraMessage: {
            caption_entities: [{ type: "mention", offset: 0, length: "@other_bot".length }],
          },
          getFile,
        });
        if (album) {
          await dispatchTelegramGroupPhoto({
            messageId: messageId + 1,
            albumId: `other-bot-album-${messageId}`,
            getFile,
          });
          await flushChannelPostMediaGroup(setTimeoutSpy);
        }

        expect(getFile).not.toHaveBeenCalled();
        expect(saveRemoteMedia).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        getChatSpy.mockReset().mockResolvedValue(undefined);
      }
    },
  );
});
