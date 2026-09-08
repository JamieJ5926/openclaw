import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import {
  sidebarDock,
  sidebarMainPanel,
  sidebarSidePanels,
  isSidebarSlotVisible,
  type SidebarLayout,
} from "./sidebar-layout.ts";

export function renderSidebarRegionFrame(params: {
  layout: SidebarLayout;
  collapsed: boolean;
  header?: TemplateResult | typeof nothing;
  primary: TemplateResult;
  controller?: TemplateResult | typeof nothing | null;
  runtime?: TemplateResult | typeof nothing | null;
}) {
  const column = params.layout.columns[0];
  const main = sidebarMainPanel(params.layout);
  const chatMain = !main || main.slot === "conversation";
  return html`<div
    class="sidebar-region ${params.collapsed ? "sidebar-region--narrow" : ""} ${
      params.layout.expanded ? "sidebar-region--expanded" : ""
    } sidebar-region--${sidebarDock(params.layout)} ${params.layout.open === true ? "sidebar-region--open" : ""}"
    style=${styleMap({
      "--side-panel-width": `${column?.width ?? 480}px`,
      "--side-panel-height": `${column?.height ?? 360}px`,
    })}
  >
    <div class="sidebar-region__header">${params.header ?? nothing}</div>
    ${params.controller ?? nothing}
    <div
      class="sidebar-region__primary"
      data-region=${chatMain ? "main" : "side"}
      ?hidden=${!isSidebarSlotVisible(params.layout, "conversation")}
    >
      ${params.primary}
    </div>
    <div class="sidebar-region__right-runtime">${params.runtime ?? nothing}</div>
  </div>`;
}

export function renderPendingSidebarRegion(
  layout: SidebarLayout,
  collapsed: boolean,
  content: TemplateResult | typeof nothing | null = nothing,
) {
  if (!layout.columns[0]) {
    return nothing;
  }
  const main = sidebarMainPanel(layout);
  const promoted = main !== undefined && main.slot !== "conversation";
  return html`
    ${!collapsed && layout.open && !layout.expanded ? html`<resizable-divider inert class="sidebar-column__divider" orientation=${sidebarDock(layout) === "bottom" ? "horizontal" : "vertical"}></resizable-divider>` : nothing}
    ${sidebarSidePanels(layout).length ? html`<div class="rail-header side-panel__header" data-region-header="side" aria-hidden="true"></div>` : nothing}
    <div
      class="side-panel__panel"
      data-region=${promoted ? "main" : "side"}
      ?hidden=${!promoted && (!layout.open || layout.expanded)}
    >
      ${content}
    </div>
  `;
}
