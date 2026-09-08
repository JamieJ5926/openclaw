import type { RouteId } from "../app-routes.ts";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext } from "./context.ts";
import type { StartupPresentationController } from "./startup-presentation.ts";

interface ShellStartupHost extends HTMLElement {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly startupPresentation?: StartupPresentationController;
  readonly routeState: ShellRouteState;
  readonly workspaceChromeVisible: boolean;
  readonly navigationSidebar: HTMLElement;
  requestUpdate(): void;
}

/** Reports committed route and pane readiness to the document's initial presentation. */
export class ShellStartupOwner {
  private startupIdentityOwner = "";
  private startupIdentityReady = false;

  constructor(private readonly host: ShellStartupHost) {}

  synchronize(sidebarFailed: boolean) {
    const host = this.host;
    const startup = host.startupPresentation;
    const context = host.context;
    if (!startup || startup.snapshot.stage === "ready" || !context) {
      return;
    }
    const route = host.routeState;
    if (
      sidebarFailed ||
      route.routeFailed ||
      (route.committedRouteId === "chat" && !route.committedSessionKey) ||
      (route.routeId && route.routeId !== "chat") ||
      context.gateway.snapshot.phase !== "connected"
    ) {
      startup.finish();
      return;
    }
    const agentId =
      context.agentSelection.state.selectedId ?? context.gateway.snapshot.assistantAgentId;
    const owner = `${context.gateway.connectionRevision}:${agentId}:${route.location?.pathname ?? ""}`;
    if (this.startupIdentityOwner !== owner) {
      this.startupIdentityOwner = owner;
      this.startupIdentityReady = false;
      const client = context.gateway.snapshot.client;
      void context.agentIdentity.ensure([agentId]).then(() => {
        if (
          host.isConnected &&
          host.context === context &&
          this.startupIdentityOwner === owner &&
          context.gateway.snapshot.client === client
        ) {
          this.startupIdentityReady = true;
          host.requestUpdate();
        }
      });
    }
    const pane = [...host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
      (candidate) => candidate.presented && candidate.visuallyPresented,
    );
    const chromeReady = Boolean(
      pane?.querySelector(".chat-pane__header") &&
      (!host.workspaceChromeVisible || host.navigationSidebar.querySelector(".sidebar-brand")) &&
      this.startupIdentityReady &&
      (context.agents.state.agentsList || context.agents.state.agentsError) &&
      (context.sessions.state.result || context.sessions.state.error),
    );
    startup.update(
      chromeReady,
      Boolean(chromeReady && pane && (!pane.conversationPresented || pane.transcriptReady)),
    );
  }
}
