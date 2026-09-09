import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();

describe("msteams monitor recipient authorization", () => {
  it.each([
    { name: "another bot by type", mentioned: [{ id: "other-bot", type: "bot" }], dispatches: 0 },
    { name: "another bot by role", mentioned: [{ id: "other-bot", role: "bot" }], dispatches: 0 },
    {
      name: "both bots",
      mentioned: [{ id: "other-bot", type: "bot" }, { id: "bot-id" }],
      dispatches: 1,
    },
    { name: "a human", mentioned: [{ id: "member", role: "user" }], dispatches: 1 },
    { name: "a tag", mentioned: [{ id: "tag", type: "tag" }], dispatches: 1 },
    { name: "an unknown account", mentioned: [{ id: "unknown" }], dispatches: 1 },
  ])(
    "routes a group mention of $name with requireMention disabled",
    async ({ mentioned, dispatches }) => {
      runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
      const { deps } = createMessageHandlerDeps({
        channels: { msteams: { groupPolicy: "open", requireMention: false } },
      });
      const handler = createMSTeamsMessageHandler(deps);
      await handler({
        activity: buildChannelActivity({
          id: "mention-message",
          text: "<at>Recipient</at> please check the build",
          from: { id: "member-id", aadObjectId: "member-aad", name: "Member" },
          conversation: { id: "19:group@thread.tacv2", conversationType: "groupChat" },
          channelData: {},
          entities: mentioned.map((account) => ({ type: "mention", mentioned: account })),
        }),
        sendActivity: vi.fn(async () => undefined),
        sendActivities: vi.fn(async () => []),
        updateActivity: vi.fn(async () => undefined),
        deleteActivity: vi.fn(async () => {}),
      });
      expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
        dispatches,
      );
    },
  );
});
