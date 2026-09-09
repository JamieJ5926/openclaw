import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOrResumeClientVoiceSession,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import type { InternalRealtimeVoiceProviderCapabilities } from "../../talk/provider-internal.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { cleanupTalkConnection } from "../talk-session-registry.js";
import { talkClientHandlers } from "./talk-client.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandler } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveProvider: vi.fn(),
  chatSend: vi.fn<GatewayRequestHandler>(),
}));
vi.mock("../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveProvider,
  resolveRealtimeVoiceProviderCapabilities: (): InternalRealtimeVoiceProviderCapabilities => ({
    transports: ["webrtc"],
    inputAudioFormats: [],
    outputAudioFormats: [],
    supportsGatewayControl: true,
    supportsToolCalls: true,
  }),
}));
vi.mock("../../talk/provider-registry.js", () => ({ listRealtimeVoiceProviders: () => [] }));
vi.mock("../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeBootstrapContextInstructions: async () => undefined,
}));
vi.mock("./chat-send-handler.js", () => ({ handleTrustedInternalChatSend: mocks.chatSend }));

const sessionKey = "selected";
const config: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { primary: {}, voice: {} } },
  talk: { agentId: "voice" },
};
const browserSession = {
  provider: "test-voice",
  transport: "webrtc" as const,
  clientSecret: "synthetic-offer-token",
  offerUrl: "/test/voice/offer",
};
let state: OpenClawTestState;
let client: GatewayClient & { connId: string };
let runNumber: number;
const calls: Array<{ agentId: string; voiceSessionId: string }> = [];
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set([client.connId]),
  chatAbortControllers: new Map(),
  logGateway: { warn: vi.fn() },
  broadcastToConnIds: vi.fn(),
} as unknown as GatewayRequestContext;

async function dispatch(method: string, params: Record<string, unknown>, conn = client) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: randomUUID(), method, params },
    client: conn,
    context,
    isWebchatConnect: () => false,
    respond,
    extraHandlers: talkClientHandlers,
  });
  return respond;
}

async function create(agentId: string, voiceSessionId: string, gatewayControl = false) {
  const respond = await dispatch("talk.client.create", {
    sessionKey,
    agentId,
    voiceSessionId,
    transport: "webrtc",
    capabilities: gatewayControl ? ["gateway-control-v1"] : [],
  });
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ...browserSession, voiceSessionId }),
    undefined,
  );
  calls.push({ agentId, voiceSessionId });
}

async function consult(agentId: string, conn = client) {
  const respond = await dispatch(
    "talk.client.toolCall",
    {
      sessionKey,
      agentId,
      callId: randomUUID(),
      name: "openclaw_agent_consult",
      args: { question: "Continue this voice call" },
    },
    conn,
  );
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ agentId, agentSessionKey: "agent:" + agentId + ":" + sessionKey }),
    undefined,
  );
  const { runId } = respond.mock.calls[0]![1] as { runId: string };
  const binding = resolveClientVoiceRunBinding(runId);
  expect(binding).toMatchObject({ agentId, sessionKey });
  return binding!.voiceSessionId;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "talk-legacy-binding" });
  client = {
    ...sharingPolicyClient({ user: ensureProfileForEmail("listener@example.test").id }),
    connId: randomUUID(),
  };
  runNumber = 0;
  calls.length = 0;
  vi.clearAllMocks();
  mocks.chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: "legacy-run-" + ++runNumber }, undefined);
  });
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider: RealtimeVoiceProviderPlugin = {
    id: "test-voice",
    label: "Test voice",
    isConfigured: () => true,
    createBridge: () => {
      throw new Error("Unexpected Gateway audio bridge creation");
    },
    createBrowserSession: async () => browserSession,
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession: async () => undefined },
  });
  mocks.resolveProvider.mockReturnValue({ provider, providerConfig: {} });
});

afterEach(async () => {
  try {
    for (const call of calls) {
      await dispatch("talk.client.close", { sessionKey, ...call });
    }
    cleanupTalkConnection(client.connId, context.logGateway);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clientVoiceSessionTesting.reset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await state.cleanup();
  }
});

describe("agent-scoped legacy voice bindings through Gateway handlers", () => {
  it.each([false, true])(
    "keeps created calls separate on one connection (gatewayControl=%s)",
    async (gatewayControl) => {
      await create("primary", "voice-primary", gatewayControl);
      await create("voice", "voice-secondary", gatewayControl);
      for (const agentId of ["primary", "voice", "primary", "voice"]) {
        expect(await consult(agentId)).toBe(
          agentId === "primary" ? "voice-primary" : "voice-secondary",
        );
      }
    },
  );

  it("pins implicit calls separately when neither client creates a voice session", async () => {
    const primary = await consult("primary");
    const secondary = await consult("voice");
    expect(secondary).not.toBe(primary);
    // Ambiguous durable records must not defeat a connection-pinned legacy call.
    for (const agentId of ["primary", "voice"]) {
      createOrResumeClientVoiceSession({ agentId, sessionKey, origin: "client" });
    }
    expect(await consult("primary")).toBe(primary);
    expect(await consult("voice")).toBe(secondary);
  });

  it.each([false, true])(
    "closing one agent preserves another agent binding with the same voice ID (gatewayControl=%s)",
    async (gatewayControl) => {
      await create("primary", "shared-voice", gatewayControl);
      await create("voice", "shared-voice");
      createOrResumeClientVoiceSession({ agentId: "voice", sessionKey, origin: "client" });
      expect(
        await dispatch("talk.client.close", {
          agentId: "primary",
          sessionKey,
          voiceSessionId: "shared-voice",
        }),
      ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(await consult("voice")).toBe("shared-voice");
    },
  );

  it("closing a replaced call preserves the newer binding", async () => {
    await create("primary", "older-voice");
    await create("primary", "newer-voice");
    createOrResumeClientVoiceSession({ agentId: "primary", sessionKey, origin: "client" });
    expect(
      await dispatch("talk.client.close", {
        agentId: "primary",
        sessionKey,
        voiceSessionId: "older-voice",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await consult("primary")).toBe("newer-voice");
  });

  it("does not share a pin across connections and expires it six hours after the last consult", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await create("primary", "original-voice");
    createOrResumeClientVoiceSession({ agentId: "primary", sessionKey, origin: "client" });
    const other = { ...client, connId: randomUUID() };
    expect(await consult("primary", other)).not.toBe("original-voice");
    vi.setSystemTime(start + 6 * 60 * 60_000 - 1);
    expect(await consult("primary")).toBe("original-voice");
    vi.setSystemTime(start + 12 * 60 * 60_000 - 1);
    expect(await consult("primary")).not.toBe("original-voice");
  });
});
