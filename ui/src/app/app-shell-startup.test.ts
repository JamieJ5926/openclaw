/* @vitest-environment jsdom */
import type { RouterState } from "@openclaw/uirouter";
import { html } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import "../plugins/control-ui-view.runtime.ts";
import { createInitializationContext } from "../pages/chat/chat-pane.test-support.ts";
import { createControlUiPluginHost } from "../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../plugins/control-ui-runtime.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { selectShellRouteState, type ShellRouteState } from "./app-host-route-state.ts";
import { ShellStartupOwner } from "./app-shell-startup.ts";
import { StartupPresentationController } from "./startup-presentation.ts";

vi.mock("../pages/chat/chat-pane.ts", () => ({}));

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

it.each(["workspace", "transcript"] as const)(
  "follows the mounted %s replacement while retaining wrapped default readiness",
  async (surface) => {
    const { host, startup, owner } = startupHarness();
    const pane = document.createElement("openclaw-chat-pane");
    Object.defineProperties(pane, {
      presented: { value: true },
      visuallyPresented: { value: true },
      composerReady: { value: true },
      conversationPresented: { value: true },
      transcriptPresentationReady: { value: false },
    });
    pane.innerHTML = '<div class="chat-pane__header"></div>';
    if (surface !== "workspace") {
      host.append(pane);
    }
    const listeners = new Set<() => void>();
    const abort = new AbortController();
    const runtime = new ControlUiPluginRuntime(() => host.context);
    vi.spyOn(runtime, "isCurrent").mockReturnValue(true);
    const pluginOwner: Omit<ControlUiPluginOwner, "host"> = {
      abort,
      client: new GatewayBrowserClient({ url: "ws://localhost" }),
      descriptor: {
        pluginId: "test",
        name: "Test",
        revision: "1",
        entryUrl: "/test.js",
        styles: [],
      },
      disposers: new Set(),
      contributions: {
        pages: new Map(),
        navigation: new Map(),
        panels: new Map(),
        actions: new Map(),
        accessories: new Map(),
        widgets: new Map(),
        replacements: new Map(),
      },
      selections: new Map(),
    };
    const pluginHost = createControlUiPluginHost(() => host.context, runtime, pluginOwner);
    let replacement: ControlUiReplacement<typeof surface> = {
      id: "startup",
      label: "Startup replacement",
      surface,
      mount(
        container: HTMLElement,
        context: ControlUiViewContext<ControlUiSurfaceProps[typeof surface]>,
      ) {
        const dispose = context.mountDefault(container);
        return { dispose };
      },
    };
    host.context = { ...host.context, plugins: runtime };
    vi.spyOn(runtime, "selectedReplacement").mockImplementation(() => ({
      key: "test/startup",
      pluginId: "test",
      value: replacement,
      host: pluginHost,
      signal: abort.signal,
    }));
    vi.spyOn(runtime, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const view = Object.assign(document.createElement("openclaw-plugin-view"), {
      surface,
      defaultView: surface === "workspace" ? html`${pane}` : html`<div class="chat-thread"></div>`,
      defaultHost: surface === "workspace" ? host : pane,
    });
    if (surface === "transcript") {
      pane.append(view);
    } else {
      host.append(view);
    }
    const provider = createApplicationContextProvider(host.context);
    provider.append(host);
    document.body.append(provider);
    startup.start();
    try {
      await vi.waitFor(() =>
        expect(
          view.querySelector(surface === "workspace" ? "openclaw-chat-pane" : ".chat-thread"),
        ).not.toBeNull(),
      );
      owner.synchronize(false);
      await Promise.resolve();
      owner.synchronize(false);
      expect(startup.snapshot.stage).not.toBe("ready");
      replacement = {
        id: "startup",
        label: "Startup replacement",
        surface,
        mount(container: HTMLElement) {
          container.textContent = "Replacement is mounted";
        },
      };
      for (const notify of listeners) {
        notify();
      }
      await vi.waitFor(() => expect(view.textContent).toBe("Replacement is mounted"));
      owner.synchronize(false);
      await vi.waitFor(() => expect(startup.snapshot.stage).toBe("ready"));
    } finally {
      startup.dispose();
      provider.remove();
      abort.abort();
      runtime.dispose();
    }
  },
);
