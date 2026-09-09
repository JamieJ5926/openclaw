import type { RouteLocation } from "@openclaw/uirouter";

export type ModelsView = "manage" | "connect";

export function readModelsView(location: Pick<RouteLocation, "search">): ModelsView {
  return new URLSearchParams(location.search).get("view") === "connect" ? "connect" : "manage";
}

export function modelsNavigationOptions(view: ModelsView): Pick<RouteLocation, "search"> {
  return { search: view === "connect" ? "?view=connect" : "" };
}
