import type { RouteId } from "../app-routes.ts";
import type { OpenClawAssistantPanel } from "../components/assistant-panel.ts";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext } from "./context.ts";
import type { StartupPresentationController } from "./startup-presentation.ts";

type StartupChatPane = ChatPaneElement & {
  compact?: boolean;
  composerReady?: boolean;
  transcriptPresentationReady?: boolean;
};

interface ShellStartupHost extends HTMLElement {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly startupPresentation?: StartupPresentationController;
  readonly routeState: ShellRouteState;
  readonly workspaceChromeVisible: boolean;
  readonly assistantRestorationPending: boolean;
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
    const phase = context.gateway.snapshot.phase;
    if (!sidebarFailed && (phase === "starting" || phase === "connecting")) {
      return;
    }
    const route = host.routeState;
    if (
      sidebarFailed ||
      route.routeFailed ||
      (route.committedRouteId === "chat" &&
        route.committedRouteStatus === "success" &&
        !route.committedSessionKey) ||
      (route.routeId && route.routeId !== "chat") ||
      phase !== "connected"
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
    const panes = [...host.querySelectorAll<StartupChatPane>("openclaw-chat-pane")].filter(
      (candidate) => candidate.presented && candidate.visuallyPresented,
    );
    const chromeReady = Boolean(
      !host.assistantRestorationPending &&
      !host.querySelector<OpenClawAssistantPanel>("openclaw-assistant-panel")
        ?.homePresentationPending &&
      panes.length > 0 &&
      panes.every((pane) => pane.composerReady) &&
      panes.every((pane) => pane.querySelector(pane.compact ? ".chat" : ".chat-pane__header")) &&
      (!host.workspaceChromeVisible || host.navigationSidebar.querySelector(".sidebar-brand")) &&
      this.startupIdentityReady &&
      (context.agents.state.agentsList || context.agents.state.agentsError) &&
      (context.sessions.state.result || context.sessions.state.error),
    );
    startup.update(
      chromeReady,
      chromeReady &&
        panes.every((pane) => !pane.conversationPresented || pane.transcriptPresentationReady),
    );
  }
}
