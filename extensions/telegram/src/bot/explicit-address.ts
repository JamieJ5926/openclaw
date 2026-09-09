import type { InboundMentionFacts } from "openclaw/plugin-sdk/channel-mention-gating";
import { isTelegramBadRequestError } from "../network-errors.js";
import { getTelegramTextParts } from "./body-helpers.js";
import { collectTelegramRichMessageAddress } from "./rich-message.js";
import type { TelegramContext, TelegramGetChat } from "./types.js";

export function resolveTelegramNativeMessageAddress(params: {
  message: TelegramContext["message"];
  botUsername?: string;
  botId?: number;
  isGroup: boolean;
}): { explicitAddress: InboundMentionFacts["explicitAddress"]; usernames: Set<string> } {
  const { message, botUsername, botId } = params;
  const selfUsername = botUsername?.toLowerCase();
  const { text, entities } = getTelegramTextParts(message);
  const richAddress = collectTelegramRichMessageAddress(message);
  const command = entities.find(
    (entity) => entity.type === "bot_command" && !text.slice(0, entity.offset).trim(),
  );
  const commandText = command
    ? text.slice(command.offset, command.offset + command.length)
    : richAddress.leadingCommand?.bot_command;
  const commandTarget = commandText?.match(/^\/[^@\s]+@([a-z0-9_]+)$/iu)?.[1];
  // A qualified leading command owns its recipient, even if its arguments mention us.
  if (commandTarget && selfUsername) {
    return {
      explicitAddress: commandTarget.toLowerCase() === selfUsername ? "self" : "other",
      usernames: new Set(),
    };
  }
  const users = [
    ...entities.filter((entity) => entity.type === "text_mention").map((entity) => entity.user),
    ...richAddress.mentions
      .filter((mention) => mention.type === "text_mention")
      .map((mention) => mention.user),
  ];
  const usernames = new Set([
    ...entities
      .filter((entity) => entity.type === "mention")
      .map((entity) => text.slice(entity.offset, entity.offset + entity.length).toLowerCase()),
    ...richAddress.mentions
      .filter((mention) => mention.type === "mention")
      .map((mention) => `@${mention.username.toLowerCase()}`),
  ]);
  if (
    users.some((user) => user.id === botId) ||
    (selfUsername !== undefined && usernames.has(`@${selfUsername}`))
  ) {
    return { explicitAddress: "self", usernames: new Set() };
  }
  if (!params.isGroup) {
    return { explicitAddress: undefined, usernames: new Set() };
  }
  // sender_chat uses a bot-shaped sender for channel and anonymous-admin posts.
  const addressedToOther =
    (message.reply_to_message?.from?.is_bot &&
      !message.reply_to_message.sender_chat &&
      message.reply_to_message.from.id !== botId) ||
    users.some((user) => user.is_bot);
  return { explicitAddress: addressedToOther ? "other" : undefined, usernames };
}

async function resolveTelegramExplicitAddress(params: {
  message: TelegramContext["message"];
  botUsername: string;
  botId: number;
  isGroup: boolean;
  getChat: TelegramGetChat;
}): Promise<InboundMentionFacts["explicitAddress"]> {
  const { explicitAddress, usernames } = resolveTelegramNativeMessageAddress(params);
  let addressedToOther = explicitAddress === "other";
  if (explicitAddress === "self") {
    return "self";
  }
  for (const username of usernames) {
    try {
      // Telegram resolves private chats by username only for bots. A username
      // suffix is not identity evidence; an unresolved recipient stays unknown.
      const chat = await params.getChat(username);
      if (chat.type === "private") {
        if (chat.id === params.botId) {
          return "self";
        }
        addressedToOther = true;
      }
    } catch (error) {
      if (!isTelegramBadRequestError(error)) {
        throw error;
      }
    }
  }
  return addressedToOther ? "other" : undefined;
}

export async function prepareTelegramMessageAddress(
  ctx: Pick<TelegramContext, "message" | "me" | "explicitAddress">,
  getChat: TelegramGetChat,
) {
  ctx.explicitAddress = ctx.me?.username
    ? await resolveTelegramExplicitAddress({
        message: ctx.message,
        botUsername: ctx.me.username,
        botId: ctx.me.id,
        isGroup: ctx.message.chat.type === "group" || ctx.message.chat.type === "supergroup",
        getChat,
      })
    : undefined;
  return ctx.explicitAddress;
}
