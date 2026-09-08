import { html } from "lit";
import { t } from "../i18n/index.ts";

function renderLoadingIndicator() {
  return html`<div class="loading-indicator" aria-hidden="true"><span></span></div>`;
}

export function renderConnectingSplash(status?: string, visible = true) {
  return html`<main
    class=${visible ? "connect-splash" : "connect-splash connect-splash--pending"}
    role="status"
    aria-live="polite"
    aria-label=${status ?? t("common.loading")}
  >
    ${renderLoadingIndicator()}
    <span class="connect-splash__status">${status ?? t("common.loading")}</span>
  </main>`;
}

export function renderLoadingState() {
  return html`
    <section
      class="lazy-view-state lazy-view-state--loading"
      role="status"
      aria-live="polite"
      aria-label=${t("common.loading")}
    >
      ${renderLoadingIndicator()}
    </section>
  `;
}
