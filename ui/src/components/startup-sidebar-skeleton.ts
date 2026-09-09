import { html, nothing } from "lit";
import type { StartupPresentation } from "../app/startup-presentation.ts";

function renderSectionHeader(width: number) {
  return html`
    <div class="sidebar-recent-sessions__head">
      <div class="sidebar-session-group-toggle">
        <span class="sidebar-session-group-toggle__lead"></span>
        <span
          class="sidebar-recent-sessions__label-text skeleton"
          style="--startup-bar-width: ${width}px"
          >${"\u00a0"}</span
        >
      </div>
    </div>
  `;
}

function renderSessionRow(width: string, avatar = false, detail = false) {
  return html`
    <div class="sidebar-recent-session ${detail ? "" : "sidebar-recent-session--single-line"}">
      <div class="sidebar-recent-session__link">
        <span class="sidebar-session-indicator"
          >${avatar ? html`<span class="nav-item__icon skeleton"></span>` : nothing}</span
        >
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row">
            <span
              class="sidebar-recent-session__name skeleton"
              style="--startup-bar-width: ${width}"
              >${"\u00a0"}</span
            >
          </span>
          ${detail ? html`<span class="sidebar-recent-session__details"></span>` : nothing}
        </span>
      </div>
    </div>
  `;
}

export function renderStartupSidebarSkeleton(presentation: StartupPresentation | undefined) {
  const sidebarEntries = presentation?.initialSidebarEntries ?? [];
  const assistantName = presentation?.initialAssistantName ?? "";
  return html`
    <aside class="sidebar startup-sidebar-skeleton" aria-hidden="true" inert>
      <div class="sidebar-shell">
        <div class="sidebar-brand">
          <div class="sidebar-agent-card">
            <div class="sidebar-agent-card__main">
              <span class="sidebar-agent-card__avatar skeleton"></span>
              <span class="sidebar-agent-card__text">
                <span class="sidebar-agent-card__name">
                  <span class="sidebar-agent-card__name-text skeleton">${assistantName}</span>
                </span>
              </span>
            </div>
          </div>
          <div class="sidebar-brand__actions">
            ${[0, 1, 2].map(
              () => html`
                <span class="sidebar-brand__icon sidebar-brand__header-control">
                  <span class="nav-item__icon skeleton"></span>
                </span>
              `,
            )}
          </div>
        </div>
        <div class="sidebar-shell__content">
          <div class="sidebar-shell__body">
            <div class="sidebar-nav">
              <div class="sidebar-nav__head"></div>
              <div class="nav-section__items">
                ${["home", ...sidebarEntries].map(
                  (_, index) => html`
                    <div class="nav-item">
                      <span class="nav-item__icon skeleton"></span>
                      <span
                        class="nav-item__text skeleton"
                        style="--startup-bar-width: ${[44, 84, 88, 56][index % 4]}px"
                        >${"\u00a0"}</span
                      >
                    </div>
                  `,
                )}
                ${[110, 140].map((width) => html`<div class="sidebar-zone-entry">${renderSessionRow(`${width}px`)}</div>`)}
              </div>
            </div>
            <section class="sidebar-online">
              ${renderSectionHeader(52)}
              <div class="sidebar-online__list">
                ${[40, 120].map(
                  (width) => html`
                    <div class="sidebar-online__row">
                      <div class="sidebar-online__person">
                        <span class="viewer-avatar viewer-avatar--footer skeleton"></span>
                        <span
                          class="sidebar-online__person-name skeleton"
                          style="--startup-bar-width: ${width}px"
                          >${"\u00a0"}</span
                        >
                      </div>
                    </div>
                  `,
                )}
              </div>
            </section>
            <section class="sidebar-sessions">
              <div class="sidebar-session-toolbar">
                <span
                  class="sidebar-recent-sessions__label-text skeleton"
                  style="--startup-bar-width: 60px"
                  >${"\u00a0"}</span
                >
                <span class="sidebar-session-toolbar__button sidebar-session-sort skeleton"></span>
                <span class="sidebar-session-toolbar__button skeleton"></span>
              </div>
              <div class="sidebar-recent-sessions">
                <div class="sidebar-recent-sessions__group">
                  ${renderSectionHeader(64)}
                  <div class="sidebar-recent-sessions__list">
                    ${renderSessionRow("88%", true)} ${renderSessionRow("70%", false, true)}
                  </div>
                </div>
                <div class="sidebar-recent-sessions__group">
                  ${renderSectionHeader(40)}
                  <div class="sidebar-recent-sessions__list">
                    ${[62, 78, 84, 92, 74, 84].map((width, index) => renderSessionRow(`${width}%`, index === 1 || index === 4))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
        <div class="sidebar-shell__footer">
          <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
            <div class="sidebar-identity-card">
              <span class="viewer-avatar viewer-avatar--footer skeleton"></span>
              <span class="sidebar-identity-card__text">
                <span class="sidebar-identity-card__name skeleton" style="--startup-bar-width: 36px"
                  >${"\u00a0"}</span
                >
              </span>
            </div>
            <span class="sidebar-footer-actions">
              <span class="sidebar-brand__icon sidebar-footer-bar__home"
                ><span class="nav-item__icon skeleton"></span
              ></span>
              <span class="sidebar-issues-button"
                ><span class="sidebar-issues-button__icon skeleton"></span
              ></span>
            </span>
          </div>
        </div>
      </div>
    </aside>
  `;
}
