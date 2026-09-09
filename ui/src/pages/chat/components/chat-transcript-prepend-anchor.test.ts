/* @vitest-environment jsdom */
import type { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureTranscriptPrependAnchor,
  restoreTranscriptPrependAnchor,
} from "./chat-transcript-prepend-anchor.ts";

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    width: 800,
    left: 0,
    right: 800,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function fixture() {
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.getBoundingClientRect = () => rect(100, 500);
  scroller.innerHTML =
    '<div class="chat-virtual-row" data-index="4"><div class="chat-bubble" data-message-id="visible"></div></div>';
  const row = scroller.firstElementChild as HTMLElement;
  const bubble = row.firstElementChild as HTMLElement;
  bubble.getBoundingClientRect = () => rect(90, 180);
  Object.defineProperty(row, "offsetHeight", { value: 600 });
  const virtualizer = {
    indexFromElement: vi.fn(() => 4),
    resizeItem: vi.fn(),
    scrollToOffset: vi.fn(),
    scrollOffset: 200,
  };
  return {
    scroller,
    row,
    bubble,
    virtualizer,
    instance: virtualizer as unknown as Virtualizer<HTMLDivElement, HTMLElement>,
  };
}

const messages = (...ids: string[]) => new Set(ids);
afterEach(() => document.body.replaceChildren());

describe("transcript prepend anchor", () => {
  it("captures a partially visible retained message, not overscan above it", () => {
    const { scroller, row } = fixture();
    const overscan = document.createElement("div");
    overscan.className = "chat-bubble";
    overscan.dataset.messageId = "above";
    overscan.getBoundingClientRect = () => rect(-200, 100);
    row.prepend(overscan);
    expect(
      captureTranscriptPrependAnchor(scroller, "above", messages("older", "above", "visible")),
    ).toEqual({ messageKey: "visible", top: 90 });
  });

  it.each([
    [messages(), messages("visible")],
    [messages("visible"), messages("visible", "new")],
    [messages("visible"), messages("replacement")],
    [messages("removed", "visible"), messages("visible")],
  ])("does not treat startup, append, replacement, or trimming as prepend", (previous, next) => {
    expect(
      captureTranscriptPrependAnchor(fixture().scroller, previous.keys().next().value, next),
    ).toBeNull();
  });

  it("resolves the committed bubble by identity and compensates without an absolute scroll command", () => {
    const { scroller, bubble, virtualizer, instance } = fixture();
    const anchor = captureTranscriptPrependAnchor(
      scroller,
      "visible",
      messages("older", "visible"),
    );
    const committed = bubble.cloneNode() as HTMLElement;
    committed.getBoundingClientRect = () => rect(390, 180);
    bubble.replaceWith(committed);
    scroller.scrollTop = 200;
    expect(restoreTranscriptPrependAnchor(anchor, scroller, instance)).toBe(true);
    expect(scroller.scrollTop).toBe(500);
    expect(virtualizer.scrollOffset).toBe(500);
    expect(virtualizer.scrollToOffset).not.toHaveBeenCalled();
  });

  it("does not request another render for an already stable message", () => {
    const { scroller, instance } = fixture();
    expect(
      restoreTranscriptPrependAnchor({ messageKey: "visible", top: 90 }, scroller, instance),
    ).toBe(false);
  });

  it("retires an anchor whose message is no longer rendered", () => {
    const { scroller, instance, virtualizer } = fixture();
    expect(
      restoreTranscriptPrependAnchor({ messageKey: "removed", top: 90 }, scroller, instance),
    ).toBe(false);
    expect(virtualizer.resizeItem).not.toHaveBeenCalled();
  });
});
