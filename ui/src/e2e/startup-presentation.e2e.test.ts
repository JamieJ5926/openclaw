import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import {
  defaultControlUiFeatureMethods,
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
  placeholderChanges: Array<{ at: number; region: string; before: string; after: string }>;
  seen: string[];
  lost: string[];
  skeleton: boolean;
  maskedAt: Record<string, number>;
  revealedAt: Record<string, number>;
  cls: number;
  containerDrift: Record<string, number>;
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
      placeholderChanges: [],
      seen: [],
      lost: [],
      skeleton: false,
      maskedAt: {},
      revealedAt: {},
      cls: 0,
      containerDrift: {},
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
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.top >= innerHeight) {
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
    const initialBounds = new Map<string, DOMRectReadOnly>();
    const placeholderPaints = new Map<string, string>();
    const maskOpacity = (element: Element) => {
      if (!onScreen(element)) {
        return 0;
      }
      const mask = getComputedStyle(element, "::after");
      let opacity = Number(mask.opacity);
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        opacity *= Number(getComputedStyle(parent).opacity);
      }
      return mask.content !== "none" && mask.visibility === "visible" ? opacity : 0;
    };
    const paintedMask = (element: Element) => maskOpacity(element) > 0.99;
    const paintedContent = (element: Element) =>
      onScreen(element) &&
      !element.closest(".startup-chat-skeleton, .startup-sidebar-skeleton, .custodian__startup") &&
      !element.classList.contains("skeleton") &&
      getComputedStyle(element).visibility === "visible" &&
      maskOpacity(element) < 1;
    const paintedCandidate = (selector: string) => {
      const candidates = [...document.querySelectorAll(selector)].filter(onScreen);
      return candidates.find(paintedContent) ?? candidates.find(paintedMask) ?? null;
    };
    const sample = () => {
      let changedPlaceholder = false;
      const rememberPaint = (region: string, paint: string) => {
        const before = placeholderPaints.get(region);
        if (before !== undefined && before !== paint) {
          changedPlaceholder = true;
          if (trace.placeholderChanges.length < 12) {
            trace.placeholderChanges.push({ at: performance.now(), region, before, after: paint });
          }
        }
        placeholderPaints.set(region, paint);
      };
      // Compare opaque painted boxes, not shimmer phase, color, or DOM ownership.
      for (const [region, selector] of [
        [
          "sidebar",
          ".shell-nav :is(.sidebar-agent-card__name-text,.nav-item__text,.sidebar-recent-session__name)",
        ],
        ["header", ".chat-pane__session-title-text"],
        ["transcript", ".chat-thread .chat-bubble"],
        ["assistantTranscript", ".assistant-panel .custodian__messages .chat-bubble"],
      ] as const) {
        const candidates = [...document.querySelectorAll(selector)];
        const boxes = candidates.filter(paintedMask).map((element) => {
          const r = element.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height].map((value) => Math.round(value * 10) / 10);
        });
        if (
          boxes.length ||
          (placeholderPaints.has(region) &&
            !candidates.some((element) => maskOpacity(element) > 0 || paintedContent(element)))
        ) {
          rememberPaint(region, JSON.stringify(boxes));
        }
      }
      const headerRevealing = [
        ...document.querySelectorAll("openclaw-chat-pane .chat-pane__session-title-text"),
      ].some(
        (element) =>
          element.getBoundingClientRect().height > 0 &&
          getComputedStyle(element).visibility === "visible",
      );
      const header = paintedCandidate(".chat-pane__session-title-text");
      if (!headerRevealing && header && paintedMask(header)) {
        const composer =
          paintedCandidate(
            ".content .chat-pane-primary-column .agent-chat__composer-combobox textarea",
          ) ??
          [
            ...document.querySelectorAll(
              ".content .chat-pane-primary-column .agent-chat__composer-combobox textarea",
            ),
          ].find(
            (element) => onScreen(element) && getComputedStyle(element).visibility === "visible",
          );
        if (composer) {
          rememberPaint("composer", composer.getAttribute("placeholder") ?? "");
        }
      }
      if (
        initialBounds.size > 0 ||
        document.querySelector('.shell[data-startup-placeholder="true"]')
      ) {
        for (const selector of [
          ".shell-nav .sidebar",
          ".chat-pane__header",
          ".chat-thread",
          ".agent-chat__composer-shell",
        ]) {
          const rect = [...document.querySelectorAll(selector)]
            .find(
              (element) => onScreen(element) && getComputedStyle(element).visibility !== "hidden",
            )
            ?.getBoundingClientRect();
          if (!rect) {
            continue;
          }
          const initial = initialBounds.get(selector) ?? rect;
          initialBounds.set(selector, initial);
          trace.containerDrift[selector] = Math.max(
            trace.containerDrift[selector] ?? 0,
            ...(["x", "y", "width", "height"] as const).map((key) =>
              Math.abs(rect[key] - initial[key]),
            ),
          );
        }
      }
      const transcript = [...document.querySelectorAll(".chat-thread p")].find(
        (p) => p.textContent === text,
      );
      const regions = [
        ["identity", paintedCandidate(".sidebar-agent-card__name-text")],
        ["sessions", paintedCandidate(".sidebar-recent-session__name")],
        ["header", paintedCandidate(".chat-pane__session-title-text")],
        ["transcript", transcript?.closest(".chat-bubble") ?? paintedCandidate(".chat-bubble")],
        ["assistantHeader", paintedCandidate(".assistant-panel-title")],
        [
          "assistantTranscript",
          paintedCandidate(".assistant-panel .custodian__messages .chat-bubble"),
        ],
      ] as const;
      const visible: string[] = [];
      for (const [name, element] of regions) {
        if (!onScreen(element)) {
          continue;
        }
        const mask = getComputedStyle(element, "::after");
        const maskVisible =
          mask.content !== "none" && mask.visibility === "visible" && Number(mask.opacity) > 0.99;
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
      if (changedPlaceholder || visible.some((name) => !trace.seen.includes(name))) {
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
  it.each([
    { staggered: false, restoredDock: false },
    { staggered: true, restoredDock: false },
    { staggered: true, restoredDock: true },
    { staggered: true, restoredDock: false, global: true },
    { staggered: true, restoredDock: false, literal: true },
  ])(
    "reveals startup in at most two stages (staggered: $staggered, restored dock: $restoredDock, global: $global, literal: $literal)",
    async ({ staggered, restoredDock, global, literal }) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            communityInvite: false,
            ...(global ? { sessionScope: "global" as const } : {}),
            ...(restoredDock
              ? {
                  featureMethods: [
                    ...defaultControlUiFeatureMethods,
                    "openclaw.chat",
                    "openclaw.chat.history",
                  ],
                  methodResponses: {
                    "openclaw.chat.history": {
                      turns: [
                        { role: "user", text: "Review the startup state.", at: 1 },
                        {
                          role: "assistant",
                          text: "The restored assistant transcript is ready.",
                          at: 2,
                        },
                        { role: "user", text: "Keep the workspace usable.", at: 3 },
                        ...Array.from({ length: 16 }, (_, index) => ({
                          role: index % 2 ? "assistant" : "user",
                          text: `Restored Ask conversation entry ${index}.`,
                          at: index + 4,
                        })),
                      ],
                    },
                  },
                }
              : {}),
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
              ? [
                  "connect",
                  "sessions.list",
                  "agent.identity.get",
                  "chat.startup",
                  "models.list",
                  ...(restoredDock ? ["openclaw.chat.history", "openclaw.chat"] : []),
                ]
              : [],
          });
          if (global) {
            await page.addInitScript(() => {
              localStorage.setItem(
                "openclaw.control.settings.v1",
                JSON.stringify({ chatMessageMaxWidth: "82%" }),
              );
            });
          }
          if (restoredDock) {
            await page.addInitScript(() => {
              localStorage.setItem(
                "openclaw.custodian.panel.v1",
                JSON.stringify({ open: true, dock: "right", width: 440, height: 420 }),
              );
            });
          }
          if (literal) {
            await page.route("**/__openclaw/control-ui-config.json", async (route) => {
              const response = await route.fetch();
              await route.fulfill({
                response,
                json: { ...(await response.json()), assistantName: "Configured Assistant" },
              });
            });
          }
          await traceStartupPaints(page);
          await page.goto(
            `${suite.server.baseUrl}${literal ? "chat/main/~key/example" : "chat/main"}`,
          );
          let pendingBounds: Awaited<ReturnType<typeof startupRegionBounds>> | undefined;
          if (staggered) {
            await gateway.waitForRequest("connect");
            const pendingComposer = page
              .locator(".content .chat-pane-primary-column .agent-chat__composer-combobox textarea")
              .first();
            await pendingComposer.waitFor();
            await page.locator('.shell[data-startup-placeholder="true"]').waitFor();
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
            if (literal) {
              await page
                .locator("openclaw-chat-pane .agent-chat__composer-combobox textarea")
                .waitFor();
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                  }),
              );
            }
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
            await page
              .locator(".content > openclaw-router-outlet .agent-chat__composer-combobox")
              .waitFor();
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
            if (restoredDock) {
              await gateway.waitForRequest("openclaw.chat.history");
              expect(await page.getByText(historyText, { exact: true }).isVisible()).toBe(false);
              await gateway.resolveDeferred("openclaw.chat.history");
              await page
                .getByText("The restored assistant transcript is ready.", { exact: true })
                .waitFor({ state: "attached" });
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                  }),
              );
            }
            await gateway.resolveDeferred("chat.startup");
          }
          await waitForControlUiRoute(page, { routeId: "chat" });
          if (restoredDock) {
            await page.locator(".assistant-panel").waitFor();
          }
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
          if (restoredDock) {
            await expect
              .poll(() =>
                page.evaluate(() =>
                  (window as TraceWindow).startupPaintTrace.seen.includes("assistantTranscript"),
                ),
              )
              .toBe(true);
          }
          const trace = await page.evaluate(() => (window as TraceWindow).startupPaintTrace);
          expect(trace.seen).toEqual(
            expect.arrayContaining(["identity", "sessions", "header", "transcript"]),
          );
          if (staggered) {
            expect(Object.keys(trace.maskedAt)).toEqual(
              expect.arrayContaining(["identity", "sessions", "header", "transcript"]),
            );
          }
          if (restoredDock) {
            await gateway.waitForRequest("openclaw.chat");
            expect(trace.seen).toContain("assistantTranscript");
            await expect
              .poll(() =>
                page
                  .locator(".custodian__messages:not(.custodian__startup)")
                  .evaluate(
                    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
                  ),
              )
              .toBeLessThanOrEqual(2);
          }
          expect(
            trace.placeholderChanges,
            "painted placeholders and composer copy remain stable before reveal",
          ).toEqual([]);
          expect(trace.reveals, JSON.stringify(trace.revealedAt)).toBeLessThanOrEqual(2);
          expect(trace.lost).toEqual([]);
          if (staggered || trace.skeleton) {
            expect(Object.keys(trace.containerDrift)).toHaveLength(4);
          }
          for (const [region, drift] of Object.entries(trace.containerDrift)) {
            expect(drift, `${region} must stay fixed from its first skeleton`).toBe(0);
          }
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
                  .locator(".content > openclaw-router-outlet .chat-thread")
                  .evaluate(
                    (thread) => thread.scrollHeight - thread.clientHeight - thread.scrollTop,
                  ),
              )
              .toBeLessThanOrEqual(2);
          }
          const textarea = page.locator(
            ".content > openclaw-router-outlet .agent-chat__composer-combobox textarea",
          );
          await textarea.fill("Retain this draft");
          await gateway.closeLatest();
          await expect.poll(() => textarea.inputValue()).toBe("Retain this draft");
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
          await page.locator("openclaw-chat-pane .chat-thread").waitFor();
        }
        await page.locator('.shell[data-startup-stage="ready"]').waitFor();
        await page.locator(".startup-chat-skeleton").waitFor({ state: "hidden" });
        expect(
          await page
            .locator("openclaw-chat-pane :is(.startup-transcript-skeleton, .chat-virtual-row)")
            .count(),
        ).toBe(0);
        expect(
          await page
            .locator(".content > openclaw-router-outlet .agent-chat__composer-combobox textarea")
            .isEnabled(),
        ).toBe(true);
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
            .locator(".content > openclaw-router-outlet .agent-chat__composer-combobox textarea")
            .fill("Continue without the sidebar");
          expect(await page.locator(".lazy-view-error__action").count()).toBe(0);
        } finally {
          failSidebar();
        }
      });
    },
  );
});
