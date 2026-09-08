import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI startup presentation",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

type PaintTrace = {
  reveals: number;
  seen: string[];
  lost: string[];
  skeleton: boolean;
  maskedAt: Record<string, number>;
  revealedAt: Record<string, number>;
  cls: number;
  shifts: Array<{
    at: number;
    value: number;
    stage: string | null;
    placeholder: string | null;
    scroll: number[];
    presentationReady: boolean | undefined;
    sources: Array<{
      node: string;
      visibility: string;
      maskOpacity: string;
      before: number[];
      after: number[];
    }>;
  }>;
};
type TraceWindow = typeof window & { startupPaintTrace: PaintTrace };
const historyText = "The startup conversation is ready.";

async function traceStartupPaints(page: Page) {
  await page.addInitScript((text) => {
    const trace: PaintTrace = {
      reveals: 0,
      seen: [],
      lost: [],
      skeleton: false,
      maskedAt: {},
      revealedAt: {},
      cls: 0,
      shifts: [],
    };
    (window as TraceWindow).startupPaintTrace = trace;
    let sessionStart = 0;
    let previousShift = 0;
    let sessionValue = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources: Array<{
            node: Node | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }>;
        };
        if (shift.hadRecentInput) {
          continue;
        }
        if (shift.startTime - previousShift > 1000 || shift.startTime - sessionStart > 5000) {
          sessionStart = shift.startTime;
          sessionValue = 0;
        }
        if (trace.shifts.length < 20) {
          trace.shifts.push({
            at: shift.startTime,
            value: shift.value,
            stage: document.querySelector(".shell")?.getAttribute("data-startup-stage") ?? null,
            placeholder:
              document.querySelector(".shell")?.getAttribute("data-startup-placeholder") ?? null,
            scroll: [...document.querySelectorAll<HTMLElement>(".chat-thread")].flatMap(
              (thread) => [thread.scrollTop, thread.scrollHeight, thread.clientHeight],
            ),
            presentationReady: document.querySelector<
              HTMLElement & { transcriptPresentationReady?: boolean }
            >("openclaw-chat-pane")?.transcriptPresentationReady,
            sources: shift.sources.map((source) => ({
              node:
                source.node instanceof Element
                  ? `${source.node.tagName}.${source.node.className}`
                  : (source.node?.nodeName ?? "detached"),
              visibility:
                source.node instanceof Element
                  ? getComputedStyle(source.node).visibility
                  : "detached",
              maskOpacity:
                source.node instanceof Element && source.node.querySelector(".chat-bubble")
                  ? getComputedStyle(source.node.querySelector(".chat-bubble")!, "::after").opacity
                  : "none",
              before: [
                source.previousRect.x,
                source.previousRect.y,
                source.previousRect.width,
                source.previousRect.height,
              ],
              after: [
                source.currentRect.x,
                source.currentRect.y,
                source.currentRect.width,
                source.currentRect.height,
              ],
            })),
          });
        }
        previousShift = shift.startTime;
        sessionValue += shift.value;
        trace.cls = Math.max(trace.cls, sessionValue);
      }
    }).observe({ type: "layout-shift", buffered: true });
    const onScreen = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.getBoundingClientRect().height === 0) {
        return false;
      }
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || Number(style.opacity) === 0) {
          return false;
        }
      }
      return true;
    };
    const sample = () => {
      const transcript = [...document.querySelectorAll(".chat-thread p")].find(
        (p) => p.textContent === text,
      );
      const regions = [
        ["identity", document.querySelector(".sidebar-agent-card__name-text")],
        ["sessions", document.querySelector(".sidebar-recent-session__name")],
        ["header", document.querySelector(".chat-pane__session-title-text")],
        [
          "transcript",
          transcript?.closest(".chat-bubble") ?? document.querySelector(".chat-bubble"),
        ],
      ] as const;
      const visible: string[] = [];
      for (const [name, element] of regions) {
        if (!onScreen(element)) {
          continue;
        }
        const mask = getComputedStyle(element, "::after");
        const maskVisible =
          mask.content !== "none" && mask.visibility === "visible" && Number(mask.opacity) > 0.05;
        if (maskVisible) {
          trace.skeleton = true;
          trace.maskedAt[name] ??= performance.now();
        } else if (
          getComputedStyle(element).visibility === "visible" &&
          (name !== "transcript" || transcript)
        ) {
          visible.push(name);
          trace.revealedAt[name] ??= performance.now();
        }
      }
      if (visible.some((name) => !trace.seen.includes(name))) {
        trace.reveals += 1;
      }
      for (const name of trace.seen) {
        if (!visible.includes(name) && !trace.lost.includes(name)) {
          trace.lost.push(name);
        }
      }
      trace.seen = [...new Set([...trace.seen, ...visible])];
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, historyText);
}

async function startupRegionBounds(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [
        ".shell-nav",
        ".content > openclaw-router-outlet",
        ".chat-pane__header",
        ".chat-thread",
        ".agent-chat__composer-shell",
      ].map((selector) => {
        const rect = [...document.querySelectorAll(selector)]
          .map((element) => element.getBoundingClientRect())
          .find((bounds) => bounds.width > 0 && bounds.height > 0);
        return [selector, rect ? ([rect.x, rect.y, rect.width, rect.height] as const) : null];
      }),
    ),
  );
}

suite.define(() => {
  it("paints a fast cold startup without ever flashing skeletons", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
        await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
        await installMockGateway(page, {
          communityInvite: false,
          historyMessages: [{ role: "assistant", content: [{ type: "text", text: historyText }] }],
          sessions: [
            createControlUiSessionRow("agent:main:main", "Startup conversation", 1_767_225_600_000),
            createControlUiSessionRow(
              "agent:main:release-checks",
              "Release checks",
              1_767_225_600_000,
            ),
          ],
        });
        await traceStartupPaints(page);
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const startedAt = await page.evaluate(() => performance.now());
        // Resolve source modules without spending the document's feedback delay.
        // Rendering and Gateway timers still run through the browser's clock.
        await page.addScriptTag({
          type: "module",
          url: `${suite.server.baseUrl}src/pages/chat/chat-page.ts`,
        });
        await page.evaluate(() => customElements.whenDefined("openclaw-chat-page"));
        for (let frame = 0; frame < 8; frame += 1) {
          await page.clock.runFor(16);
          await page.waitForLoadState("networkidle");
          if (
            await page.evaluate(() =>
              (window as TraceWindow).startupPaintTrace.seen.includes("transcript"),
            )
          ) {
            break;
          }
        }
        const trace = await page.evaluate(() => (window as TraceWindow).startupPaintTrace);
        expect(trace.seen).toEqual(
          expect.arrayContaining(["identity", "sessions", "header", "transcript"]),
        );
        expect(trace.revealedAt.transcript).toBeLessThan(startedAt + 150);
        expect(trace.skeleton, "a completed startup must never arm delayed skeletons").toBe(false);
        await page.clock.runFor(500);
        expect(await page.evaluate(() => (window as TraceWindow).startupPaintTrace.skeleton)).toBe(
          false,
        );
      },
    );
  });
  it.each([false, true])(
    "reveals startup in at most two stages (staggered: %s)",
    async (staggered) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            communityInvite: false,
            historyMessages: [
              ...(staggered
                ? Array.from({ length: 60 }, (_, index) => ({
                    role: index % 2 ? "assistant" : "user",
                    content: [{ type: "text", text: `Earlier conversation entry ${index}.` }],
                  }))
                : []),
              { role: "assistant", content: [{ type: "text", text: historyText }] },
            ],
            sessions: [
              createControlUiSessionRow(
                "agent:main:release-checks",
                "Release checks",
                1_788_864_000_000,
              ),
              createControlUiSessionRow(
                "agent:main:main",
                "Startup conversation",
                1_788_864_000_000,
              ),
            ],
            heldMethods: staggered
              ? ["connect", "sessions.list", "agent.identity.get", "chat.startup", "models.list"]
              : [],
          });
          await traceStartupPaints(page);
          await page.goto(`${suite.server.baseUrl}chat/main`);
          let pendingBounds: Awaited<ReturnType<typeof startupRegionBounds>> | undefined;
          if (staggered) {
            await gateway.waitForRequest("connect");
            const pendingComposer = page.locator(".agent-chat__composer-combobox textarea").first();
            await pendingComposer.waitFor();
            expect(await pendingComposer.isDisabled()).toBe(true);
            const loadingStatus = page.locator(
              'openclaw-session-progress-hovercard-provider > [role="status"]',
            );
            expect(await loadingStatus.textContent()).toContain("Loading");
            expect(
              await loadingStatus.evaluate((element) => element.closest("[inert]")),
            ).toBeNull();
            expect(await page.locator("openclaw-app-shell").getAttribute("aria-busy")).toBe("true");
            pendingBounds = await startupRegionBounds(page);
            expect(await page.locator(".connect-splash, .loading-indicator").count()).toBe(0);
            await gateway.resolveDeferred("connect");
            await gateway.waitForRequest("sessions.list");
            await gateway.resolveDeferred("sessions.list");
            await gateway.waitForRequest("agent.identity.get");
            // Separate endpoint completions by painted frames, not by implementation timers.
            await page.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }),
            );
            await gateway.resolveDeferred("agent.identity.get");
            await waitForControlUiRoute(page, { routeId: "chat" });
            await gateway.waitForRequest("chat.startup");
            await gateway.waitForRequest("models.list");
            expect(
              await page.evaluate(() =>
                (window as TraceWindow).startupPaintTrace.seen.includes("header"),
              ),
            ).toBe(false);
            await gateway.resolveDeferred("models.list");
            await page.locator(".agent-chat__composer-combobox").waitFor();
            await expect
              .poll(() =>
                page.evaluate(() =>
                  (window as TraceWindow).startupPaintTrace.seen.includes("header"),
                ),
              )
              .toBe(true);
            await expect
              .poll(() => page.evaluate(() => (window as TraceWindow).startupPaintTrace.skeleton))
              .toBe(true);
            await gateway.resolveDeferred("chat.startup");
          }
          await waitForControlUiRoute(page, { routeId: "chat" });
          await page.getByText(historyText, { exact: true }).waitFor();
          await expect
            .poll(() =>
              page.evaluate(() =>
                (window as TraceWindow).startupPaintTrace.seen.includes("transcript"),
              ),
            )
            .toBe(true);
          expect(await page.locator("openclaw-app-shell").getAttribute("aria-busy")).toBe("false");
          expect(
            await page
              .locator('openclaw-session-progress-hovercard-provider > [role="status"]')
              .textContent(),
          ).not.toContain("Loading");
          const trace = await page.evaluate(() => (window as TraceWindow).startupPaintTrace);
          expect(trace.seen).toEqual(
            expect.arrayContaining(["identity", "sessions", "header", "transcript"]),
          );
          expect(trace.reveals).toBeLessThanOrEqual(2);
          expect(trace.lost).toEqual([]);
          expect(
            trace.cls,
            `startup must not shift the reserved layout: ${JSON.stringify(trace.shifts)}`,
          ).toBe(0);
          for (const [region, shownAt] of Object.entries(trace.maskedAt)) {
            expect(
              shownAt,
              `${region} skeleton must not paint during the initial delay`,
            ).toBeGreaterThanOrEqual(150);
            expect(
              trace.revealedAt[region],
              `${region} skeleton must remain visible for at least 300ms (one frame tolerance)`,
            ).toBeGreaterThanOrEqual(shownAt + 280);
          }
          if (pendingBounds) {
            const readyBounds = await startupRegionBounds(page);
            for (const [region, pending] of Object.entries(pendingBounds)) {
              expect(pending, `${region} must reserve its opening footprint`).not.toBeNull();
              const ready = readyBounds[region];
              expect(ready, `${region} must remain mounted`).not.toBeNull();
              for (const coordinate of [0, 1, 2, 3] as const) {
                expect(
                  Math.abs(ready![coordinate] - pending![coordinate]),
                  region,
                ).toBeLessThanOrEqual(1);
              }
            }
          }
          if (staggered) {
            await expect
              .poll(() =>
                page
                  .locator(".chat-thread")
                  .evaluate(
                    (thread) => thread.scrollHeight - thread.clientHeight - thread.scrollTop,
                  ),
              )
              .toBeLessThanOrEqual(2);
          }
          await page.locator(".agent-chat__composer-combobox textarea").fill("Retain this draft");
          await gateway.closeLatest();
          await expect
            .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue())
            .toBe("Retain this draft");
          expect(await page.locator(".connect-splash").count()).toBe(0);
        },
      );
    },
  );

  it.each(["empty", "failed"])(
    "reveals the %s initial history outcome without virtual rows",
    async (outcome) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          historyMessages: [],
          deferredMethods: ["chat.startup"],
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        await gateway.waitForRequest("chat.startup");
        if (outcome === "failed") {
          await gateway.rejectDeferred("chat.startup", {
            code: "GATEWAY_UNAVAILABLE",
            message: "Chat history is temporarily unavailable.",
          });
          await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
        } else {
          await gateway.resolveDeferred("chat.startup");
          await page.locator(".chat-thread").waitFor();
        }
        await page.locator('.shell[data-startup-stage="ready"]').waitFor();
        expect(await page.locator(".startup-transcript-skeleton, .chat-virtual-row").count()).toBe(
          0,
        );
        expect(await page.locator(".agent-chat__composer-combobox textarea").isEnabled()).toBe(
          true,
        );
      });
    },
  );

  it.each(["archived", "catalog without metadata"])(
    "opens the %s transcript when ordinary composition is unavailable",
    async (kind) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const catalog = kind === "catalog without metadata";
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          historyMessages: [{ role: "assistant", content: [{ type: "text", text: historyText }] }],
          sessions: [
            createControlUiSessionRow("agent:main:main", "Archived conversation", 1, {
              archived: true,
            }),
          ],
          methodResponses: catalog
            ? {
                "sessions.catalog.list": {
                  catalogs: [
                    {
                      id: "beam",
                      label: "Shared transcripts",
                      capabilities: { continueSession: false, archive: false },
                      hosts: [
                        {
                          hostId: "gateway",
                          label: "Gateway",
                          kind: "gateway",
                          connected: true,
                          sessions: [],
                        },
                      ],
                    },
                  ],
                },
                "sessions.catalog.read": {
                  hostId: "gateway",
                  threadId: "shared",
                  items: [{ id: "answer", type: "agentMessage", text: historyText }],
                },
              }
            : {},
        });
        await page.goto(
          `${suite.server.baseUrl}chat/main${catalog ? "?catalog=beam&host=gateway&thread=shared" : ""}`,
        );
        await waitForControlUiRoute(page, { routeId: "chat" });
        await gateway.waitForRequest(catalog ? "sessions.catalog.read" : "chat.startup");
        await page.getByText(historyText, { exact: true }).waitFor();
        expect(await page.locator(".connect-splash, openclaw-panel-loading-skeleton").count()).toBe(
          0,
        );
        if (catalog) {
          await page
            .getByText("This external session source is view-only.", { exact: true })
            .waitFor();
        } else {
          expect(
            await page
              .locator(
                "openclaw-chat-pane.chat-pane-cache__pane--visible .agent-chat__composer-combobox textarea",
              )
              .count(),
          ).toBe(0);
        }
      });
    },
  );

  it("shows a missing session's recovery action and opens the main session", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        communityInvite: false,
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: historyText }] }],
      });
      await page.goto(`${suite.server.baseUrl}chat/main/deadbeef`);
      await waitForControlUiRoute(page, { routeId: "chat" });
      await page.getByText("Session not found", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Go to main session", exact: true }).click();
      await page.getByText(historyText, { exact: true }).waitFor();
      expect(await page.locator(".connect-splash").count()).toBe(0);
    });
  });

  it.each(["cold", "warm", "cold with another modal"])(
    "keeps chat available with sidebar recovery on %s startup",
    async (mode) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          authMethod: "token",
          authMode: "token",
          presenceUsers: [{ id: "sidebar-profile", self: true }],
          historyMessages: [{ role: "assistant", content: [{ type: "text", text: historyText }] }],
        });
        const url = `${suite.server.baseUrl}chat/main#token=test-token`;
        if (mode === "warm") {
          await page.goto(url);
          await waitForControlUiRoute(page, { routeId: "chat" });
          await page.getByText(historyText, { exact: true }).waitFor();
          await page.waitForFunction(() =>
            Object.keys(localStorage).some((key) =>
              key.startsWith("openclaw.control.bootRecord.v1:"),
            ),
          );
        }
        let failSidebar = () => {};
        const sidebarGate =
          mode === "cold with another modal"
            ? new Promise<void>((resolve) => {
                failSidebar = resolve;
              })
            : Promise.resolve();
        await page.route("**/components/app-sidebar.ts*", async (route) => {
          await sidebarGate;
          await route.abort();
        });
        try {
          if (mode === "warm") {
            await page.reload();
          } else {
            await page.goto(url);
          }
          if (mode === "cold with another modal") {
            await page.route("**/components/command-palette.ts*", (route) => route.abort());
            await page.locator(".shell").waitFor();
            await page.keyboard.press("Control+K");
            const otherModal = page.locator('openclaw-modal-dialog[label="command palette"]');
            await otherModal.locator(".lazy-view-error__action").waitFor();
            const sidebarFailed = page.waitForEvent("requestfailed", (request) =>
              request.url().includes("/components/app-sidebar.ts"),
            );
            failSidebar();
            await sidebarFailed;
            await waitForControlUiRoute(page, { routeId: "chat" });
            await page.getByText(historyText, { exact: true }).waitFor();
            expect(await otherModal.locator(".lazy-view-error__action").count()).toBe(1);
            await otherModal.getByRole("button", { name: "Close", exact: true }).click();
          }
          await waitForControlUiRoute(page, { routeId: "chat" });
          if (mode === "warm") {
            expect(
              await page.evaluate(
                () =>
                  document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
                    "openclaw-app",
                  )?.runtime?.warmBoot,
              ),
            ).toBe(true);
          }
          await gateway.waitForRequest("chat.startup");
          await page.getByText(historyText, { exact: true }).waitFor();
          const sidebarError = page.locator('openclaw-modal-dialog[label="openclaw-app-sidebar"]');
          await sidebarError.locator(".lazy-view-error__action").waitFor();
          expect(await page.locator(".connect-splash").count()).toBe(0);
          expect(await page.locator(".shell").getAttribute("inert")).toBeNull();
          await sidebarError.getByRole("button", { name: "Close", exact: true }).click();
          await page.locator(".lazy-view-error__action").waitFor({ state: "detached" });
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("Continue without the sidebar");
          expect(await page.locator(".lazy-view-error__action").count()).toBe(0);
        } finally {
          failSidebar();
        }
      });
    },
  );
});
