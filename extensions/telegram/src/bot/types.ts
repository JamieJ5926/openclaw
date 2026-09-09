// Telegram type declarations define plugin contracts.
import type { Context } from "grammy";
import type { ChatFullInfo, Message, Update, UserFromGetMe } from "grammy/types";
import type { InboundMentionFacts } from "openclaw/plugin-sdk/channel-inbound";

/** App-specific stream mode for Telegram stream previews. */
export type TelegramStreamMode = "off" | "partial" | "block" | "progress";

type TelegramGetFile = Context["getFile"];
export type TelegramChatDetails = {
  id?: number | string;
  type?: ChatFullInfo["type"];
  available_reactions?: ChatFullInfo["available_reactions"] | null;
  is_forum?: boolean;
};
export type TelegramGetChat = (chatId: number | string) => Promise<TelegramChatDetails>;

/**
 * Minimal context projection from Grammy's Context class.
 * Decouples the message processing pipeline from Grammy's full Context,
 * and allows constructing synthetic contexts for debounced/combined messages.
 */
export type TelegramContext = {
  message: Message;
  update?: Update;
  me?: UserFromGetMe;
  getFile: TelegramGetFile;
  recipient?: {
    explicitAddress: InboundMentionFacts["explicitAddress"];
    shouldSkip: boolean;
  };
};

/** Telegram sticker metadata for context enrichment and caching. */
export interface StickerMetadata {
  /** Emoji associated with the sticker. */
  emoji?: string;
  /** Name of the sticker set the sticker belongs to. */
  setName?: string;
  /** Telegram file_id for sending the sticker back. */
  fileId?: string;
  /** Stable file_unique_id for cache deduplication. */
  fileUniqueId?: string;
  /** Cached description from previous vision processing (skip re-processing if present). */
  cachedDescription?: string;
}
