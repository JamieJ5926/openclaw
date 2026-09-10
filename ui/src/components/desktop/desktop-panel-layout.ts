import { createDockPanelLayout } from "../dock-panel-layout.ts";

/** Embedded and fullscreen viewers let their host own both dimensions. */
export function desktopPanelStyle(
  fillAvailableSpace: boolean,
  layout: { dock: "bottom" | "right"; height: number; width: number },
): string {
  if (fillAvailableSpace) {
    return "";
  }
  return layout.dock === "bottom" ? `height:${layout.height}px` : `width:${layout.width}px`;
}

export const desktopPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.desktopPanel",
  minHeight: 240,
  minWidth: 380,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 560,
});
