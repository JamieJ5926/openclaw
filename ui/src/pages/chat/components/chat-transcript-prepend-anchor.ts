import type { Virtualizer } from "@tanstack/virtual-core";

export type ChatTranscriptPrependAnchor = { messageKey: string; top: number };

/** Capture the message being read before older history changes its containing row. */
export function captureTranscriptPrependAnchor(
  scrollElement: HTMLDivElement | null,
  previousFirstMessageKey: string | undefined,
  next: ReadonlySet<string>,
): ChatTranscriptPrependAnchor | null {
  const first = previousFirstMessageKey;
  if (!scrollElement || !first || first === next.keys().next().value || !next.has(first)) {
    return null;
  }
  const viewport = scrollElement.getBoundingClientRect();
  // Only rendered, retained bubbles can anchor the reader; overscan above the
  // viewport and messages removed by the new projection are not candidates.
  for (const bubble of scrollElement.querySelectorAll<HTMLElement>(
    ".chat-bubble[data-message-id]",
  )) {
    const messageKey = bubble.dataset.messageId;
    const rect = bubble.getBoundingClientRect();
    if (
      messageKey &&
      next.has(messageKey) &&
      rect.bottom > viewport.top &&
      rect.top < viewport.bottom
    ) {
      return { messageKey, top: rect.top };
    }
  }
  return null;
}

/** Reconcile the inner-message anchor after the virtualizer commits its row anchor. */
export function restoreTranscriptPrependAnchor(
  anchor: ChatTranscriptPrependAnchor | null,
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  if (!anchor || !scrollElement) {
    return false;
  }
  // Group renderers may replace the bubble at an array index during prepend;
  // resolve its stable render key in the committed DOM, not an old element.
  const bubble = [
    ...scrollElement.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
  ].find((element) => element.dataset.messageId === anchor.messageKey);
  if (!bubble) {
    return false;
  }
  const delta = bubble.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) <= 1) {
    return false;
  }
  const offset = Math.max(0, scrollElement.scrollTop + delta);
  // This is layout compensation, not an absolute scroll command: a command
  // would undo subsequent ResizeObserver corrections to newly measured rows.
  scrollElement.scrollTop = offset;
  virtualizer.scrollOffset = scrollElement.scrollTop;
  return true;
}
