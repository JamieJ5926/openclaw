import { html } from "lit";
import { classifySessionKind } from "../../../src/sessions/classify-session-kind.js";
import { t } from "../i18n/index.ts";
import { renderPendingChatComposer } from "./chat-composer-surface.ts";
import "../styles/startup-skeletons.css";

/** Reserve the transcript's canonical message columns until history is known. */
export function renderChatTranscriptSkeleton() {
  return html`<div class="startup-transcript-skeleton" aria-hidden="true" inert>
    ${["user", "assistant"].map(
      (role) => html`<div class="chat-group ${role}">
        <span class="chat-avatar skeleton"></span>
        <div class="chat-group-messages">
          <div class="chat-bubble">
            <div class="chat-text skeleton startup-transcript-line">${"\u00a0"}</div>
          </div>
        </div>
      </div>`,
    )}
  </div>`;
}

export function renderStartupChatSkeleton(sessionKey: string, assistantName: string) {
  const kind = classifySessionKind(sessionKey);
  const direct = kind === "direct" || kind === "cron" || kind === "spawn-child";
  return html`<div class="startup-chat-skeleton">
    <div class="chat-pane__header" aria-hidden="true" inert>
      <div class="chat-pane__crumbs">
        <span class="chat-pane__workspace-chip">
          <span class="workspace-icon skeleton"></span>
          <span class="skeleton">${"\u00a0"}</span>
        </span>
        <span class="chat-pane__crumb-sep">/</span>
        <span class="chat-pane__session-title">
          <span class="chat-pane__session-title-text skeleton">${assistantName}</span>
        </span>
      </div>
    </div>
    <div class="chat">
      <div class="chat-main__conversation">
        <div class="chat-thread ${direct ? "chat-thread--direct" : ""}">
          <div class="chat-thread-inner">${renderChatTranscriptSkeleton()}</div>
        </div>
        ${renderPendingChatComposer(t("chat.composer.placeholder", { name: assistantName }))}
      </div>
    </div>
  </div>`;
}
