import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { classifySessionKind } from "../../../src/sessions/classify-session-kind.js";
import type { UiSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./resizable-divider.ts";
import {
  fitSidebarLayout,
  isSidebarRegionCollapsed,
  normalizeSidebarLayout,
  type SidebarLayout,
} from "../pages/chat/sidebar-layout.ts";
import {
  renderPendingSidebarRegion,
  renderSidebarRegionFrame,
} from "../pages/chat/sidebar-region-frame.ts";
import { renderPendingChatComposer } from "./chat-composer-surface.ts";
import "../styles/startup-skeletons.css";

/** Reserve the transcript's canonical message columns until history is known. */
export function renderChatTranscriptSkeleton() {
  return html`<div class="startup-transcript-skeleton" aria-hidden="true" inert>
    ${["user", "assistant", "user", "assistant"].map(
      (role) => html`<div class="chat-group ${role}">
        <span class="chat-avatar skeleton"></span>
        <div class="chat-group-messages">
          <div class="chat-bubble">
            ${
              role === "user"
                ? html`<div class="chat-text">${"\u00a0"}</div>`
                : html`<div class="chat-text startup-transcript-lines">
                    <div class="skeleton skeleton-line"></div>
                    <div class="skeleton skeleton-line skeleton-line--long"></div>
                    <div class="skeleton skeleton-line skeleton-line--medium"></div>
                    <div class="skeleton skeleton-line startup-transcript-line--short"></div>
                  </div>`
            }
          </div>
        </div>
      </div>`,
    )}
  </div>`;
}

function renderPane(
  direct: boolean,
  assistantName: string,
  layout: SidebarLayout,
  width: number,
  chatMessageMaxWidth: string | undefined,
) {
  const header = html`<div class="chat-pane__header" aria-hidden="true" inert>
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
  </div>`;
  const primary = html`<div class="chat-pane-primary-column">
    <div
      class="chat"
      style=${styleMap(
        chatMessageMaxWidth
          ? {
              "--chat-thread-max-width": chatMessageMaxWidth,
              "--chat-message-max-width": "100%",
            }
          : {},
      )}
    >
      <div class="chat-main__conversation">
        <div class="chat-thread ${direct ? "chat-thread--direct" : ""}">
          <div class="chat-thread-inner">${renderChatTranscriptSkeleton()}</div>
        </div>
        ${renderPendingChatComposer(t("chat.composer.placeholder", { name: assistantName }))}
      </div>
    </div>
  </div>`;
  const narrow = isSidebarRegionCollapsed(layout, width);
  const runtime = renderPendingSidebarRegion(layout, narrow);
  return renderSidebarRegionFrame({ layout, collapsed: narrow, header, primary, runtime });
}

class StartupChatPane extends OpenClawLightDomElement {
  @property() sessionKey = "";
  @property() assistantName = "";
  @property() chatMessageMaxWidth?: string;
  private initialSessionKind?: ReturnType<typeof classifySessionKind>;
  @property({ attribute: false }) sidebarLayout: SidebarLayout = { columns: [] };
  private readonly resizeObserver = new ResizeObserver(() => this.requestUpdate());
  override connectedCallback() {
    super.connectedCallback();
    this.style.cssText = "display:flex;flex-direction:column;flex:1 1 0;min-width:0;min-height:0";
    this.resizeObserver.observe(this);
  }
  override disconnectedCallback() {
    this.resizeObserver.disconnect();
    super.disconnectedCallback();
  }
  override render() {
    const width = this.getBoundingClientRect().width;
    // Alias hydration must not change the already-painted placeholder's avatar column.
    const kind = (this.initialSessionKind ??= classifySessionKind(this.sessionKey));
    return renderPane(
      kind === "direct" || kind === "cron" || kind === "spawn-child",
      this.assistantName,
      fitSidebarLayout(this.sidebarLayout, width) ?? this.sidebarLayout,
      width,
      this.chatMessageMaxWidth,
    );
  }
}
if (!customElements.get("openclaw-startup-chat-pane")) {
  customElements.define("openclaw-startup-chat-pane", StartupChatPane);
}

export function renderStartupChatSkeleton(
  sessionKey: string,
  assistantName: string,
  settings: Pick<UiSettings, "chatSplitLayout" | "sidebarSessionLayouts" | "chatMessageMaxWidth">,
) {
  const layout = settings.chatSplitLayout ?? {
    columns: [{ id: "startup", panes: [{ id: "startup", sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: "startup",
  };
  const narrow = matchMedia("(max-width: 1099px)").matches;
  return html`<div class="startup-chat-skeleton">
    <div class="chat-split-view__drop-container">
      <div class="chat-split-view ${narrow ? "chat-split-view--narrow" : ""}">
        ${layout.columns.map(
          (column, columnIndex) => html`<div
              class="chat-split-view__column ${narrow && !column.panes.some((pane) => pane.id === layout.activePaneId) ? "chat-split-view__column--narrow-hidden" : ""}"
              style="flex:${layout.columnWeights[columnIndex]} 1 0"
            >
              ${column.panes.map((pane, paneIndex) => {
                const key = pane.id === layout.activePaneId ? sessionKey : pane.sessionKey;
                return html`<div
                    class="chat-split-view__cell ${settings.chatSplitLayout && pane.id === layout.activePaneId ? "chat-split-view__cell--active" : ""} ${narrow && pane.id !== layout.activePaneId ? "chat-split-view__cell--narrow-hidden" : ""}"
                    style="flex:${column.paneWeights[paneIndex]} 1 0"
                  >
                    <openclaw-startup-chat-pane
                      .sessionKey=${key}
                      .assistantName=${assistantName}
                      .chatMessageMaxWidth=${settings.chatMessageMaxWidth}
                      .sidebarLayout=${normalizeSidebarLayout(settings.sidebarSessionLayouts?.[key])}
                    ></openclaw-startup-chat-pane>
                  </div>
                  ${!narrow && paneIndex < column.panes.length - 1 ? html`<resizable-divider inert orientation="horizontal"></resizable-divider>` : nothing}`;
              })}
            </div>
            ${!narrow && columnIndex < layout.columns.length - 1 ? html`<resizable-divider inert></resizable-divider>` : nothing}`,
        )}
      </div>
    </div>
  </div>`;
}
