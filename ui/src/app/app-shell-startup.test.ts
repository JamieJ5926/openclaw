/* @vitest-environment jsdom */
import type { RouterState } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import { createInitializationContext } from "../pages/chat/chat-pane.test-support.ts";
import { selectShellRouteState, type ShellRouteState } from "./app-host-route-state.ts";
import { ShellStartupOwner } from "./app-shell-startup.ts";
import { StartupPresentationController } from "./startup-presentation.ts";

afterEach(() => vi.restoreAllMocks());

function startupHarness() {
  const context = createInitializationContext();
  Object.assign(context.gateway.snapshot, { phase: "connected" });
  Object.assign(context.agents.state, { agentsError: "Roster unavailable" });
  Object.assign(context.sessions.state, { error: "Sessions unavailable" });
  Object.assign(context, { agentIdentity: { ensure: async () => undefined } });
  const startup = new StartupPresentationController(() => undefined);
  const routeState: ShellRouteState = {
    committedRouteId: "chat",
    committedSessionKey: "agent:main:main",
  };
  const host = Object.assign(document.createElement("div"), {
    context,
    startupPresentation: startup,
    routeState,
    workspaceChromeVisible: false,
    assistantRestorationPending: false,
    navigationSidebar: document.createElement("nav"),
    requestUpdate: vi.fn(),
  });
  // The owner reads mounted panes; avoid running the unrelated pane lifecycle.
  vi.spyOn(host, "isConnected", "get").mockReturnValue(true);
  return { host, startup, owner: new ShellStartupOwner(host) };
}

it.each(["header", "history", "compact history", "compact mount"])(
  "waits for every visible split pane's %s without waiting for retained hidden panes",
  async (pendingBoundary) => {
    const { host, startup, owner } = startupHarness();
    const pane = (presented: boolean, visuallyPresented: boolean, ready: boolean) => {
      const element = document.createElement("openclaw-chat-pane");
      Object.defineProperties(element, {
        presented: { value: presented },
        visuallyPresented: { value: visuallyPresented },
        conversationPresented: { value: true, writable: true },
        composerReady: { value: true },
        transcriptReady: { value: ready, writable: true },
        transcriptPresentationReady: { value: ready, writable: true },
      });
      element.innerHTML = '<div class="chat-pane__header"></div>';
      host.append(element);
      return element;
    };
    pane(true, true, true);
    const delayed = pane(true, true, false);
    pane(false, true, false);
    pane(true, false, false);
    if (pendingBoundary !== "history") {
      delayed.replaceChildren();
    }
    if (pendingBoundary.startsWith("compact")) {
      Object.defineProperty(delayed, "compact", { value: true });
      if (pendingBoundary === "compact history") {
        delayed.innerHTML = '<div class="chat"></div>';
      } else {
        Object.defineProperty(delayed, "conversationPresented", { value: false });
      }
    }
    host.assistantRestorationPending = true;
    const home = document.createElement("openclaw-assistant-panel");
    Object.defineProperty(home, "homePresentationPending", { value: false, writable: true });
    host.append(home);
    startup.start();
    try {
      owner.synchronize(false);
      await Promise.resolve();
      owner.synchronize(false);
      expect(startup.snapshot.stage).toBe("pending");
      host.assistantRestorationPending = false;
      Object.defineProperty(home, "homePresentationPending", { value: true });
      owner.synchronize(false);
      expect(startup.snapshot.stage).toBe("pending");
      Object.defineProperty(home, "homePresentationPending", { value: false });
      owner.synchronize(false);
      expect(startup.snapshot.stage).toBe(
        pendingBoundary === "header" || pendingBoundary === "compact mount" ? "pending" : "chrome",
      );
      delayed.innerHTML = pendingBoundary.startsWith("compact")
        ? '<div class="chat"></div>'
        : '<div class="chat-pane__header"></div>';
      Object.defineProperty(delayed, "conversationPresented", { value: true });
      owner.synchronize(false);
      expect(startup.snapshot.stage).toBe("chrome");
      Object.defineProperty(delayed, "transcriptReady", { value: true });
      owner.synchronize(false);
      expect(startup.snapshot.stage).toBe("chrome");
      Object.defineProperty(delayed, "transcriptPresentationReady", { value: true });
      owner.synchronize(false);
      expect(startup.snapshot.stage).toBe("ready");
    } finally {
      startup.dispose();
    }
  },
);

it.each(["missing-session", "session"])(
  "keeps an unresolved alias covered until its loader returns %s",
  async (outcome) => {
    const { host, startup, owner } = startupHarness();
    const location = {
      pathname: "/chat",
      search: "?__openclawSessionPath=%2Fchat%2Fmain",
      hash: "",
    };
    const state: RouterState<RouteId> = {
      location,
      resolvedLocation: null,
      status: "loading",
      matches: [
        {
          id: "chat-alias",
          routeId: "chat",
          location,
          deps: "",
          status: "pending",
          isFetching: "loader",
          updatedAt: 0,
          fetchCount: 1,
          abortController: new AbortController(),
          cause: "navigation",
          preload: false,
          invalid: false,
        },
      ],
      pendingMatches: [],
      cachedMatches: [],
    };
    startup.start();
    try {
      host.routeState = selectShellRouteState(state);
      owner.synchronize(false);
      expect(startup.snapshot.stage).toBe("pending");
      host.routeState = selectShellRouteState({
        ...state,
        status: "success",
        matches: state.matches.map((match) =>
          Object.assign({}, match, {
            status: "success" as const,
            isFetching: false as const,
            data:
              outcome === "session"
                ? { kind: "session", sessionKey: "agent:main:main", face: "chat" }
                : {
                    kind: "missing-session",
                    face: "chat",
                    currentSessionHref: "/chat/main",
                    sessionsHref: "/sessions",
                  },
          }),
        ),
      });
      owner.synchronize(false);
      if (outcome === "session") {
        expect(startup.snapshot.stage).toBe("pending");
        const pane = document.createElement("openclaw-chat-pane");
        Object.defineProperties(pane, {
          presented: { value: true },
          visuallyPresented: { value: true },
          conversationPresented: { value: true },
          composerReady: { value: true },
          transcriptReady: { value: false, writable: true },
          transcriptPresentationReady: { value: false, writable: true },
        });
        pane.innerHTML = '<div class="chat-pane__header"></div>';
        host.append(pane);
        await Promise.resolve();
        owner.synchronize(false);
        expect(startup.snapshot.stage).toBe("chrome");
        Object.defineProperty(pane, "transcriptReady", { value: true });
        Object.defineProperty(pane, "transcriptPresentationReady", { value: true });
        owner.synchronize(false);
      }
      expect(startup.snapshot.stage).toBe("ready");
    } finally {
      startup.dispose();
    }
  },
);

it("keeps chat available after sidebar recovery is dismissed before connection", () => {
  const { host, startup, owner } = startupHarness();
  host.workspaceChromeVisible = true;
  Object.assign(host.context.gateway.snapshot, { phase: "connecting" });
  startup.start();
  try {
    owner.synchronize(true);
    owner.synchronize(false);
    Object.assign(host.context.gateway.snapshot, { phase: "connected" });
    owner.synchronize(false);
    expect(startup.snapshot.stage).toBe("ready");
  } finally {
    startup.dispose();
  }
});
