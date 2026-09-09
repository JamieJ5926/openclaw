import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import * as providerNormalization from "../../agents/provider-model-normalization.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as pluginMetadata from "../../plugins/current-plugin-metadata-snapshot.js";
import * as manifestScan from "../../plugins/manifest-metadata-scan.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

type NativeStatusSelectionCase = {
  agentId?: string;
  modelThinking?: "low" | "high";
  selection: string;
  source: "user" | "auto" | undefined;
  channelModel?: string;
  deliveryChannel?: string;
  directSenderId?: string;
  directUserId?: string;
  expectedModel?: string;
  expectedProvider?: string;
  groupId?: string;
  locked?: boolean;
  modelParentSessionKey?: string;
  preparedModel?: string;
  preparedProvider?: string;
  parentPin?: "raw-config" | "resolved" | "legacy";
};

const buildStatusReplyMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

describe("native /status channel model routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    vi.spyOn(preparedModelCatalog, "readPreparedModelCatalog").mockResolvedValue([]);
    vi.spyOn(preparedModelCatalog, "getPreparedModelCatalogSnapshot").mockReturnValue({
      entries: [
        {
          id: "gpt-5.5",
          name: "GPT",
          provider: "openai",
          contextWindow: 400_000,
          reasoning: false,
        },
        {
          id: "claude-fable-5",
          name: "Fable",
          provider: "anthropic",
          contextWindow: 1_000_000,
          reasoning: true,
        },
      ],
      routeVariants: [],
    });
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "selected model status" });
  });

  const statusSelectionCases: NativeStatusSelectionCase[] = [
    {
      selection: "alpha per-agent model thinking",
      source: undefined,
      agentId: "alpha",
      modelThinking: "low",
      channelModel: "openai/gpt-5.5",
    },
    {
      selection: "beta per-agent model thinking",
      source: undefined,
      agentId: "beta",
      modelThinking: "high",
      channelModel: "openai/gpt-5.5",
    },
    ...(["raw-config", "resolved", "legacy"] as const).map((parentPin) => ({
      selection: `${parentPin} parent model with a colliding input alias`,
      source: undefined,
      parentPin,
      groupId: parentPin === "raw-config" ? "unmatched-child" : undefined,
      channelModel: parentPin === "raw-config" ? "custom/latest" : undefined,
      expectedProvider: "custom",
      expectedModel: "middle",
    })),
    { selection: "user override", source: "user" },
    { selection: "automatic fallback", source: "auto" },
    {
      selection: "channel override",
      source: undefined,
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "configured channel model alias",
      source: undefined,
      channelModel: "Fable",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current command channel over stale session delivery",
      source: undefined,
      deliveryChannel: "discord",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "parent group override for a topic",
      source: undefined,
      groupId: "123:topic:77",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "thread-only model parent session override",
      source: undefined,
      groupId: "unmatched-thread",
      modelParentSessionKey: "agent:main:telegram:group:123:thread:77",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "native direct peer override before wildcard",
      source: undefined,
      directUserId: "native-peer-42",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current direct sender override before wildcard",
      source: undefined,
      directSenderId: "live-peer-43",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current direct sender over another channel's persisted peer",
      source: undefined,
      deliveryChannel: "discord",
      directUserId: "stale-discord-peer",
      directSenderId: "live-telegram-peer",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "locked model selection",
      source: undefined,
      locked: true,
    },
    {
      selection: "prepared non-default heartbeat or fallback model",
      source: undefined,
      preparedProvider: "xai",
      preparedModel: "grok-4.3",
      expectedProvider: "xai",
      expectedModel: "grok-4.3",
    },
  ];

  it.each(statusSelectionCases)(
    "preserves canonical native /status $selection",
    async (testCase) => {
      const agentId = testCase.agentId ?? "main";
      const targetSessionKey = `agent:${agentId}:main`;
      const storePath = path.join(tempDirs.make("openclaw-native-status-"), "sessions.json");
      const {
        channelModel = "anthropic/claude-fable-5",
        deliveryChannel = "telegram",
        directSenderId,
        directUserId,
        expectedModel = "gpt-5.5",
        expectedProvider = "openai",
        groupId = "123",
        locked = false,
        modelParentSessionKey,
        modelThinking,
        preparedModel = "gpt-5.5",
        preparedProvider = "openai",
        source,
        parentPin,
      } = testCase;
      const parentSessionKey = `agent:${agentId}:telegram:group:parent`;
      const capturedCatalog = parentPin
        ? [
            { provider: "custom", id: "middle", name: "Selected", reasoning: true },
            {
              provider: "anthropic",
              id: "claude-fable-5",
              name: "Fable",
              contextWindow: 1_000_000,
              reasoning: true,
            },
          ]
        : undefined;
      if (parentPin) {
        vi.spyOn(pluginMetadata, "getCurrentPluginMetadataSnapshot").mockReturnValue(
          createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "status-input-owner",
                modelIdNormalization: {
                  providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
                },
              },
            ],
          }),
        );
        vi.spyOn(manifestScan, "listOpenClawPluginManifestMetadata").mockReturnValue([]);
        vi.spyOn(providerNormalization, "normalizeProviderModelIdWithRuntime").mockReturnValue(
          undefined,
        );
        await replaceSessionEntry(
          { agentId, storePath, sessionKey: parentSessionKey },
          {
            sessionId: "parent-status",
            updatedAt: 1,
            ...(parentPin === "raw-config"
              ? {}
              : {
                  providerOverride: "custom",
                  modelOverride: "middle",
                  modelOverrideSource: "user" as const,
                }),
            ...(parentPin === "resolved" ? { modelOverrideRouteResolution: parentPin } : {}),
          },
        );
      }
      const isDirect = directUserId !== undefined || directSenderId !== undefined;
      const overrideKey = directSenderId ?? directUserId ?? "123";
      const conflictingDirectUserId =
        directSenderId !== undefined && directUserId !== undefined ? directUserId : undefined;
      await replaceSessionEntry(
        { agentId, sessionKey: targetSessionKey, storePath },
        {
          sessionId: "status-session",
          updatedAt: Date.now(),
          contextTokens: 1_000_000,
          ...(parentPin ? { parentSessionKey } : {}),
          delivery: normalizeSessionDeliveryState({
            context: { channel: deliveryChannel },
            ...(directUserId
              ? { origin: { provider: deliveryChannel, nativeDirectUserId: directUserId } }
              : {}),
          }),
          ...(isDirect ? {} : { groupId }),
          ...(locked ? { modelSelectionLocked: true } : {}),
          ...(source
            ? {
                providerOverride: "anthropic",
                modelOverride: "claude-fable-5",
                modelOverrideSource: source,
                ...(source === "auto"
                  ? {
                      modelOverrideFallbackOriginProvider: "openai",
                      modelOverrideFallbackOriginModel: "gpt-5.5",
                      modelProvider: "openai",
                      model: "gpt-5.5",
                    }
                  : {}),
              }
            : {}),
        },
      );

      const parentBefore = parentPin
        ? loadSessionEntryReadOnly({ agentId, storePath, sessionKey: parentSessionKey })
        : undefined;
      const result = await maybeResolveNativeSlashCommandFastReply({
        ctx: buildTestCtx({
          Body: "/status",
          CommandBody: "/status",
          CommandSource: "native",
          CommandAuthorized: true,
          Provider: "telegram",
          Surface: "telegram",
          ChatType: isDirect ? "direct" : "group",
          ...(directSenderId
            ? { From: `telegram:${directSenderId}`, SenderId: directSenderId }
            : {}),
          ...(modelParentSessionKey ? { ModelParentSessionKey: modelParentSessionKey } : {}),
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: targetSessionKey,
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
            commandName: "status",
            body: "/status",
          },
        }),
        cfg: markCompleteReplyConfig({
          session: { store: storePath },
          agents: {
            ...(modelThinking
              ? {
                  ownership: "explicit" as const,
                  entries: {
                    [agentId]: {
                      models: { "openai/gpt-5.5": { params: { thinking: modelThinking } } },
                    },
                  },
                }
              : {}),
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              modelPolicy: { allow: ["openai/*", "anthropic/*", "xai/*"] },
              models: {
                ...(modelThinking ? { "openai/gpt-5.5": { params: { thinking: "medium" } } } : {}),
                "anthropic/claude-fable-5": {
                  alias: "Fable",
                  params: { thinking: "high", fastMode: true },
                },
              },
            },
          },
          channels: {
            modelByChannel: {
              telegram: {
                [parentPin === "raw-config" ? "parent" : overrideKey]: channelModel,
                ...(conflictingDirectUserId ? { [conflictingDirectUserId]: "xai/grok-4.3" } : {}),
                "*": "openai/gpt-5.5",
              },
              discord: { "123": "openai/gpt-5.5" },
            },
          },
        } as OpenClawConfig),
        agentId,
        agentDir: "/tmp/agent",
        agentCfg: undefined,
        commandAuthorized: true,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        aliasIndex: {
          byKey: new Map(),
          byAlias: new Map([
            ["fable", { alias: "Fable", ref: { provider: "anthropic", model: "claude-fable-5" } }],
          ]),
        },
        provider: preparedProvider,
        model: preparedModel,
        workspaceDir: "/tmp/workspace",
        typing: createTypingController(),
        ...(capturedCatalog
          ? { preparedModelCatalog: { entries: capturedCatalog, routeVariants: capturedCatalog } }
          : {}),
      });

      const statusCall = buildStatusReplyMock.mock.calls[0]?.[0];
      expect(statusCall).toMatchObject({
        agentId,
        provider: expectedProvider,
        model: expectedModel,
      });
      if (modelThinking) {
        await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe(modelThinking);
      }
      expect(statusCall.thinkingCatalog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "anthropic",
            id: "claude-fable-5",
            contextWindow: 1_000_000,
          }),
        ]),
      );
      if (expectedProvider === "anthropic") {
        await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe("high");
      }
      if (parentPin) {
        await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe("medium");
        await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe("medium");
        expect(vi.mocked(preparedModelCatalog.readPreparedModelCatalog).mock.calls.length).toBe(0);
        expect(vi.mocked(manifestScan.listOpenClawPluginManifestMetadata).mock.calls.length).toBe(
          0,
        );
        expect(
          vi.mocked(providerNormalization.normalizeProviderModelIdWithRuntime).mock.calls.length,
        ).toBe(0);
        expect(
          loadSessionEntryReadOnly({ agentId, storePath, sessionKey: parentSessionKey }),
        ).toEqual(parentBefore);
        const childAfter = loadSessionEntryReadOnly({
          agentId,
          storePath,
          sessionKey: targetSessionKey,
        });
        expect(childAfter?.modelOverride).toBeUndefined();
        expect(childAfter?.providerOverride).toBeUndefined();
        expect(childAfter?.authProfileOverride).toBeUndefined();
      }
      if (source) {
        expect(statusCall.sessionEntry).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-fable-5",
          modelOverrideSource: source,
        });
      } else {
        expect(statusCall.sessionEntry).not.toHaveProperty("providerOverride");
        expect(statusCall.sessionEntry).not.toHaveProperty("modelOverride");
      }
      expect(result).toMatchObject({ reply: { text: "selected model status" } });
    },
  );
});
