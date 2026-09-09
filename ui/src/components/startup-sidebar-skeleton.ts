import { html } from "lit";
import type { StartupPresentation } from "../app/startup-presentation.ts";

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
                  () => html`
                    <div class="nav-item">
                      <span class="nav-item__icon skeleton"></span>
                      <span class="nav-item__text skeleton">${"\u00a0"}</span>
                    </div>
                  `,
                )}
              </div>
            </div>
            <section class="sidebar-sessions">
              <div class="sidebar-session-toolbar">
                <span class="sidebar-recent-sessions__label-text skeleton">${"\u00a0"}</span>
              </div>
              <div class="sidebar-recent-sessions">
                ${[0, 1, 2].map(
                  () => html`
                    <div class="sidebar-recent-sessions__group">
                      <div class="sidebar-recent-sessions__head">
                        <span class="sidebar-session-group-toggle__lead skeleton"></span>
                        <span class="sidebar-recent-sessions__label-text skeleton"
                          >${"\u00a0"}</span
                        >
                      </div>
                      <div class="sidebar-recent-sessions__list">
                        ${[0, 1, 2, 3].map(
                          () => html`
                            <div class="sidebar-recent-session sidebar-recent-session--single-line">
                              <div class="sidebar-recent-session__link">
                                <span class="nav-item__icon skeleton"></span>
                                <span class="sidebar-recent-session__text">
                                  <span class="sidebar-recent-session__title-row">
                                    <span class="sidebar-recent-session__name skeleton"
                                      >${"\u00a0"}</span
                                    >
                                  </span>
                                </span>
                              </div>
                            </div>
                          `,
                        )}
                      </div>
                    </div>
                  `,
                )}
              </div>
            </section>
          </div>
        </div>
        <div class="sidebar-shell__footer">
          <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
            <span class="nav-item__icon skeleton"></span>
            <span class="nav-item__text skeleton">${"\u00a0"}</span>
          </div>
        </div>
      </div>
    </aside>
  `;
}
