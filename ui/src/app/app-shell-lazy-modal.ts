import { html, nothing } from "lit";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import { t } from "../i18n/index.ts";
import type {
  LazyCustomElementRequestController,
  OptionalCustomElement,
} from "./lazy-custom-element.ts";

export function renderShellLazyModal(
  requests: LazyCustomElementRequestController,
  sidebar: LazyCustomElementRequestController,
  commandPalette: OptionalCustomElement,
) {
  const state = requests.visibleState;
  if (state?.status === "loading" && state.element === commandPalette) {
    return renderCommandPaletteLoading(() => requests.close());
  }
  if (state) {
    return renderLazyElementModal(requests);
  }
  return sidebar.visibleState?.status === "error" ? renderLazyElementModal(sidebar) : nothing;
}

function renderCommandPaletteLoading(onClose: () => void) {
  const label = t("palette.placeholder");
  return html`<openclaw-modal-dialog
    class="cmd-palette-overlay palette"
    label=${label}
    style="--openclaw-modal-width: min(640px, calc(100vw - 32px));"
    @modal-cancel=${onClose}
  >
    <div class="cmd-palette" role="status" aria-label=${t("common.loading")}>
      <input class="cmd-palette__input" disabled placeholder=${label} />
      <div class="cmd-palette__empty">${t("common.loading")}</div>
    </div>
  </openclaw-modal-dialog>`;
}
