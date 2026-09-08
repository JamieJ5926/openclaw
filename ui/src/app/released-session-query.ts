import type { RouteLocation } from "@openclaw/uirouter";
import type { AgentsListResult } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";

type ReleasedSessionQuery = {
  face: BoardFace;
  sessionKey: string;
};

export function resolvePersistedAgentId(
  selectedAgentId: string | null | undefined,
  agentsList: AgentsListResult | null,
): string | null {
  const selectedId = selectedAgentId?.trim();
  if (!selectedId || !agentsList) {
    return null;
  }
  const normalizedId = normalizeAgentId(selectedId);
  return agentsList.agents.some((agent) => normalizeAgentId(agent.id) === normalizedId)
    ? normalizedId
    : null;
}

export function releasedSessionQuery(
  location: Pick<RouteLocation, "pathname" | "search">,
  basePath: string,
): ReleasedSessionQuery | null {
  const params = new URLSearchParams(location.search);
  if (!params.has("session")) {
    return null;
  }
  const chatRoot = pathForRoute("chat", basePath);
  const dashboardRoot = pathForRoute("dashboard", basePath);
  const pathFace =
    location.pathname === chatRoot || location.pathname === `${chatRoot}/`
      ? "chat"
      : location.pathname === dashboardRoot || location.pathname === `${dashboardRoot}/`
        ? "dashboard"
        : null;
  if (!pathFace) {
    return null;
  }
  return {
    face: params.get("face") === "dashboard" ? "dashboard" : pathFace,
    sessionKey: params.get("session")?.trim() ?? "",
  };
}

export function resolveReleasedSessionQueryAgentId(
  sessionKey: string,
  selectedAgentId: string | null | undefined,
  defaults: Parameters<typeof resolveUiDefaultAgentId>[0] & { agentsList: AgentsListResult | null },
): string {
  return (
    parseAgentSessionKey(sessionKey)?.agentId ??
    (resolvePersistedAgentId(selectedAgentId, defaults.agentsList) ||
      resolveUiDefaultAgentId(defaults))
  );
}
