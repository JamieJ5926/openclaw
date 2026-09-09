import type { Message, RichBlock, RichBlockCaption, RichText } from "grammy/types";

type TelegramRichMessage = { rich_message?: Message.RichMessageMessage["rich_message"] };
type TelegramRichMention = Extract<RichText, { type: "mention" | "text_mention" }>;
export type TelegramRichMessageAddress = {
  mentions: TelegramRichMention[];
  leadingCommand?: Extract<RichText, { type: "bot_command" }>;
};
type RichMessageTraversal = TelegramRichMessageAddress & { hasVisibleText: boolean };

const TELEGRAM_RICH_MESSAGE_PLACEHOLDER = "[unsupported Telegram rich_message received]";

function compactRichText(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function recordRichText(text: string, state?: RichMessageTraversal): string {
  if (state && compactRichText(text)) {
    state.hasVisibleText = true;
  }
  return text;
}

function joinRichText(parts: string[], separator: string): string {
  return parts.map(compactRichText).filter(Boolean).join(separator);
}

function renderRichInlineText(value: RichText | undefined, state?: RichMessageTraversal): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return recordRichText(value, state);
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => renderRichInlineText(part, state))
      .filter(Boolean)
      .join("");
  }
  switch (value.type) {
    case "anchor":
      return "";
    case "button":
      return renderRichInlineText(value.button.text, state);
    case "custom_emoji":
      return recordRichText(value.alternative_text, state);
    case "mathematical_expression":
      return recordRichText(value.expression, state);
    case "code":
      // Code stays visible in the body, but its examples do not address a recipient.
      return recordRichText(renderRichInlineText(value.text), state);
    case "bot_command": {
      const startsVisibleText = !state?.hasVisibleText;
      const text = renderRichInlineText(value.text, state);
      if (state && startsVisibleText && compactRichText(text)) {
        state.leadingCommand = value;
      }
      return text;
    }
    case "mention":
    case "text_mention": {
      const text = renderRichInlineText(value.text, state);
      if (compactRichText(text)) {
        state?.mentions.push(value);
      }
      return text;
    }
    default:
      return renderRichInlineText(value.text, state);
  }
}

function renderRichCaption(
  caption: RichBlockCaption | undefined,
  state?: RichMessageTraversal,
): string {
  return caption
    ? joinRichText(
        [
          renderRichInlineText(caption.text, state),
          renderRichInlineText(caption.credit ?? "", state),
        ],
        "\n",
      )
    : "";
}

function renderRichBlock(block: RichBlock, state?: RichMessageTraversal): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "footer":
    case "thinking":
      return renderRichInlineText(block.text, state);
    case "pre":
      return recordRichText(renderRichInlineText(block.text), state);
    case "expandable_blockquote":
    case "pullquote":
      return joinRichText(
        [renderRichInlineText(block.text, state), renderRichInlineText(block.credit ?? "", state)],
        "\n",
      );
    case "mathematical_expression":
      return recordRichText(block.expression, state);
    case "blockquote":
      return joinRichText(
        [renderRichInlineText(block.credit ?? "", state), renderRichBlocks(block.blocks, state)],
        "\n",
      );
    case "collage":
    case "slideshow":
      return joinRichText(
        [renderRichCaption(block.caption, state), renderRichBlocks(block.blocks, state)],
        "\n",
      );
    case "details":
      return joinRichText(
        [renderRichInlineText(block.summary, state), renderRichBlocks(block.blocks, state)],
        "\n",
      );
    case "list":
      return joinRichText(
        block.items.map((item) =>
          joinRichText(
            [recordRichText(item.label, state), renderRichBlocks(item.blocks, state)],
            "\n",
          ),
        ),
        "\n",
      );
    case "table":
      return joinRichText(
        [
          renderRichInlineText(block.caption ?? "", state),
          ...block.cells.flatMap((row) =>
            row.map((cell) => renderRichInlineText(cell.text ?? "", state)),
          ),
        ],
        "\n",
      );
    case "animation":
    case "audio":
    case "document":
    case "map":
    case "photo":
    case "video":
    case "voice_note":
      return renderRichCaption(block.caption, state);
    case "buttons":
      return joinRichText(
        block.buttons.map((button) => renderRichInlineText(button.text, state)),
        "\n",
      );
    case "anchor":
    case "divider":
      return "";
  }
  block satisfies never;
  return "";
}

function renderRichBlocks(blocks: readonly RichBlock[], state?: RichMessageTraversal): string {
  return joinRichText(
    blocks.map((block) => renderRichBlock(block, state)),
    "\n",
  );
}

export function collectTelegramRichMessageAddress(
  msg: TelegramRichMessage,
): TelegramRichMessageAddress {
  const state: RichMessageTraversal = { mentions: [], hasVisibleText: false };
  // Share visible field order with rendering; code still occupies the leading-command position.
  renderRichBlocks(msg.rich_message?.blocks ?? [], state);
  return { mentions: state.mentions, leadingCommand: state.leadingCommand };
}

export function resolveTelegramRichMessagePlaceholder(
  msg: TelegramRichMessage,
): string | undefined {
  return msg.rich_message ? TELEGRAM_RICH_MESSAGE_PLACEHOLDER : undefined;
}

export function resolveTelegramRichMessageText(msg: TelegramRichMessage): string | undefined {
  if (!msg.rich_message) {
    return undefined;
  }
  return compactRichText(renderRichBlocks(msg.rich_message.blocks)) || undefined;
}

export function resolveTelegramRichMessageBody(msg: TelegramRichMessage): string | undefined {
  return resolveTelegramRichMessageText(msg) ?? resolveTelegramRichMessagePlaceholder(msg);
}
