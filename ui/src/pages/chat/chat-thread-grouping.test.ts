// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  collapseCompletedTurnWork,
  coalesceActivityRuns,
  groupMessages,
} from "./chat-thread-grouping.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

function forwardedMessage(sessionKey: string, content = "Forwarded report") {
  return {
    role: "assistant",
    content,
    timestamp: 1,
    senderLabel: "Forwarded from main",
    senderSession: { sessionKey, agentId: "main" },
  };
}

function cachedGroups(messages: unknown[]) {
  return buildCachedChatItems({
    paneId: "forwarded-attribution",
    sessionKey: "agent:target:main",
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  }).filter((item) => item.kind === "group");
}

describe("reasoning activity boundaries", () => {
  it.each([
    { type: "text", text: "Visible answer" },
    { type: "image", source: { type: "url", url: "https://example.com/result.png" } },
    {
      type: "attachment",
      attachment: { kind: "document", url: "https://example.com/result.pdf", label: "Result" },
    },
    {
      type: "canvas",
      preview: {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        url: "https://example.com/result",
      },
    },
    { type: "future-visible-block" },
  ])("preserves mixed reasoning and $type as the visible outcome", (outcome) => {
    const thinking = { type: "thinking", thinking: "Checking the evidence." };
    const messages = [
      { role: "user", content: "Check it.", timestamp: 1_000 },
      { role: "assistant", content: [thinking], timestamp: 2_000 },
      { role: "assistant", content: [thinking, outcome], timestamp: 3_000 },
    ];
    const groups = groupMessages(
      messages.map((message, index) => ({
        kind: "message",
        key: `message:${index}`,
        message,
      })),
    );
    expect(
      collapseCompletedTurnWork(groups, {
        sessionKey: "agent:main:dashboard:reasoning",
        runWorking: false,
      }),
    ).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "work-group", groups: [{ messages: [{ message: messages[1] }] }] },
      { kind: "group", messages: [{ message: messages[2] }] },
    ]);
    const reasoningGroup = groups[1];
    expect(reasoningGroup?.kind).toBe("group");
    if (reasoningGroup?.kind === "group") {
      expect(assistantGroupCanOwnActiveRunStatus(reasoningGroup)).toBe(false);
    }
  });
});

describe("forwarded source-session grouping", () => {
  beforeEach(() => resetChatThreadState());

  it("carries the first message's source session while grouping messages from that source", () => {
    const messages = [
      forwardedMessage("agent:main:main", "First report"),
      forwardedMessage("agent:main:main", "Second report"),
    ];
    const items: ChatItem[] = messages.map((message, index) => ({
      kind: "message",
      key: `message:${index}`,
      message,
    }));

    expect(groupMessages(items)).toMatchObject([
      {
        senderLabel: "Forwarded from main",
        senderSession: { sessionKey: "agent:main:main", agentId: "main" },
        messages: [{ message: messages[0] }, { message: messages[1] }],
      },
    ]);
  });

  it("splits messages from different source sessions even when the agent labels match", () => {
    const items: ChatItem[] = ["agent:main:main", "agent:main:dashboard:other"].map(
      (sessionKey, index) => ({
        kind: "message",
        key: `message:${index}`,
        message: forwardedMessage(sessionKey, `Report ${index}`),
      }),
    );

    const groups = groupMessages(items);
    expect(groups).toHaveLength(2);
    expect(groups).toMatchObject([
      { senderSession: { sessionKey: "agent:main:main" } },
      { senderSession: { sessionKey: "agent:main:dashboard:other" } },
    ]);
  });

  it("does not collapse identical reports from different source sessions before grouping", () => {
    const groups = cachedGroups([
      forwardedMessage("agent:main:main"),
      forwardedMessage("agent:main:dashboard:other"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.messages.length === 1)).toBe(true);
    expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it.each([
    { senderSession: { sessionKey: "agent:main:main", agentId: "main" } },
    { provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
  ])("clears stale human reply attribution at a forwarded boundary %o", (attribution) => {
    const groups = cachedGroups([
      { role: "user", content: "Alice's question", __openclaw: { senderId: "alice" } },
      { role: "user", content: "Bob's question", __openclaw: { senderId: "bob" } },
      { role: "assistant", content: "Answer for Bob" },
      {
        role: "assistant",
        content: "Forwarded report",
        senderLabel: "Forwarded from main",
        ...attribution,
      },
      { role: "assistant", content: "Response to the forwarded report" },
    ]);

    expect(groups).toHaveLength(5);
    expect(groups[2]?.replyToSender).toEqual({ id: "bob" });
    expect(groups[3]?.replyToSender).toBeUndefined();
    expect(groups[4]?.replyToSender).toBeUndefined();
  });

  it.each([
    { sessionKey: "agent:main:dashboard:other", agentId: "main" },
    { sessionKey: "agent:main:main", agentId: "updated" },
  ])("refreshes cached attribution when the source changes to %o", (senderSession) => {
    const message = forwardedMessage("agent:main:main");
    const initial = cachedGroups([message]);
    message.senderSession = senderSession;

    const refreshed = cachedGroups([message]);

    expect(refreshed[0]?.senderSession).toEqual(senderSession);
    expect(refreshed[0]).not.toBe(initial[0]);
  });
});

describe("cached group content classification", () => {
  beforeEach(() => resetChatThreadState());

  it.each(["user", "assistant", "toolResult"])(
    "preserves %s messages when normalization skips malformed content blocks",
    (role) => {
      for (const content of [[null], [null, { type: "text", text: "Still visible" }]]) {
        const message = { role, content };
        expect(groupMessages([{ kind: "message", key: "malformed", message }])).toMatchObject([
          { kind: "group", messages: [{ key: "malformed", message }] },
        ]);
      }
    },
  );

  it("keeps media visible and folds commentary after the same message changes in place", () => {
    const content: Record<string, unknown>[] = [
      { type: "image", url: "https://example.com/diagram.png" },
    ];
    const preview = {
      role: "assistant",
      content,
      timestamp: 2,
    };
    const messages = [
      { role: "user", content: "Build a diagram", timestamp: 1 },
      preview,
      {
        role: "toolResult",
        toolCallId: "render-diagram",
        toolName: "render",
        content: "Ready",
        timestamp: 3,
      },
      { role: "assistant", content: "Done", timestamp: 4 },
    ];
    const project = () =>
      collapseCompletedTurnWork(cachedGroups([...messages]), {
        sessionKey: "agent:target:dashboard:history",
        runWorking: false,
      });

    expect(project()).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "group", role: "assistant", messages: [{ message: preview }] },
      { kind: "work-group", groups: [{ role: "tool" }] },
      { kind: "group", role: "assistant" },
    ]);

    preview.content.splice(0, 1, { type: "text", text: "Preparing a diagram" });

    expect(project()).toMatchObject([
      { kind: "group", role: "user" },
      {
        kind: "work-group",
        groups: [{ role: "assistant", messages: [{ message: preview }] }, { role: "tool" }],
      },
      { kind: "group", role: "assistant" },
    ]);
  });
});

describe("explicit answer visibility across continuations", () => {
  beforeEach(() => resetChatThreadState());

  it.each([
    { phase: "final_answer", tool: true },
    { phase: "final_answer", tool: false },
    { phase: "commentary", tool: true },
    { phase: "commentary", tool: false },
  ] as const)(
    "preserves an answer before $phase with intervening tool=$tool",
    ({ phase, tool }) => {
      const signed = (text: string, messagePhase: string) => ({
        type: "text",
        text,
        textSignature: JSON.stringify({ v: 1, id: text, phase: messagePhase }),
      });
      const messages = [
        { role: "user", content: "Investigate", timestamp: 1, __openclaw: { runId: "run" } },
        {
          role: "assistant",
          content: [signed("Substantive answer", "final_answer")],
          timestamp: 2,
          __openclaw: { runId: "run" },
        },
        ...(tool
          ? [
              {
                role: "toolResult",
                toolCallId: "call",
                toolName: "read",
                content: "Evidence",
                timestamp: 3,
                __openclaw: { runId: "run" },
              },
            ]
          : []),
        {
          role: "assistant",
          content: [signed("Later update", phase)],
          timestamp: 4,
          __openclaw: { runId: "run" },
        },
      ];
      // Exercise the renderer's complete grouping pipeline, including a history reload.
      for (const history of [messages, structuredClone(messages)]) {
        const items = coalesceAgentRunFrames(
          coalesceActivityRuns(
            collapseCompletedTurnWork(cachedGroups(history), {
              sessionKey: "agent:main:dashboard:answers",
              runWorking: false,
            }),
          ),
        );
        const parts = items.flatMap((item) =>
          item.kind === "agent-run-frame" ? item.parts : [item],
        );
        const visible = parts.flatMap((item) =>
          item.kind === "group" ? item.messages.map(({ message }) => message) : [],
        );
        expect(visible).toContainEqual(messages[1]);
        expect(visible).toContainEqual(messages.at(-1));
        if (tool && phase === "final_answer") {
          expect(parts.find((item) => item.kind === "work-group")).toMatchObject({
            groups: [{ role: "tool" }],
          });
        }
        if (phase === "commentary") {
          expect(
            parts.filter((item) => item.kind === "group" && item.role === "assistant"),
          ).toHaveLength(2);
        }
      }
    },
  );

  it("preserves mixed-phase answer text when later tools and an answer arrive", () => {
    const answer = {
      role: "assistant",
      content: ["commentary", "final_answer"].map((phase) => ({
        type: "text",
        text: phase === "commentary" ? "Checking" : "Substantive answer",
        textSignature: JSON.stringify({ v: 1, id: phase, phase }),
      })),
      timestamp: 2,
    };
    const items = collapseCompletedTurnWork(
      cachedGroups([
        { role: "user", content: "Investigate", timestamp: 1 },
        answer,
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: "Evidence",
          timestamp: 3,
        },
        { role: "assistant", phase: "final_answer", content: "Later update", timestamp: 4 },
      ]),
      { sessionKey: "agent:main:dashboard:answers", runWorking: false },
    );
    expect(
      items
        .filter((item) => item.kind === "group")
        .flatMap((item) => item.messages.map(({ message }) => message)),
    ).toContainEqual(answer);
  });
});
