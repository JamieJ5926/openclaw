import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI startup presentation",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

type PaintTrace = { reveals: number; seen: string[]; skeleton: boolean; lost: string[] };
type TraceWindow = typeof window & { startupPaintTrace: PaintTrace };
const historyText = "The startup conversation is ready.";

async function traceStartupPaints(page: Page) {
  await page.addInitScript((text) => {
    const trace: PaintTrace = { reveals: 0, seen: [], skeleton: false, lost: [] };
    (window as TraceWindow).startupPaintTrace = trace;
    const painted = (element: Element | null): boolean => {
      if (!(element instanceof HTMLElement) || element.getBoundingClientRect().height === 0) {
        return false;
      }
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
      }
      return true;
    };
    const sample = () => {
      const regions = [
        ["identity", document.querySelector(".sidebar-brand")],
        ["sessions", document.querySelector(".sidebar-recent-sessions__list")],
        ["header", document.querySelector(".chat-pane__header")],
        ["composer", document.querySelector(".agent-chat__composer-combobox")],
        [
          "transcript",
          [...document.querySelectorAll(".chat-thread p")].find((p) => p.textContent === text) ??
            null,
        ],
      ] as const;
      const visible = regions.filter(([, element]) => painted(element)).map(([name]) => name);
      if (visible.some((name) => !trace.seen.includes(name))) {
        trace.reveals += 1;
      }
      for (const name of trace.seen) {
        if (!visible.some((region) => region === name) && !trace.lost.includes(name)) {
          trace.lost.push(name);
        }
      }
      trace.seen = [...new Set([...trace.seen, ...visible])];
      trace.skeleton ||= [
        ...document.querySelectorAll(".skeleton, openclaw-panel-loading-skeleton"),
      ].some(painted);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, historyText);
}

suite.define(() => {
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
            heldMethods: staggered ? ["sessions.list", "agent.identity.get", "chat.startup"] : [],
          });
          await traceStartupPaints(page);
          await page.goto(`${suite.server.baseUrl}chat/main`);
          if (staggered) {
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
            await gateway.waitForRequest("chat.startup");
            await page.locator(".agent-chat__composer-combobox").waitFor();
            await expect
              .poll(() =>
                page.evaluate(() =>
                  (window as TraceWindow).startupPaintTrace.seen.includes("composer"),
                ),
              )
              .toBe(true);
            await expect
              .poll(() => page.evaluate(() => (window as TraceWindow).startupPaintTrace.skeleton))
              .toBe(true);
            await gateway.resolveDeferred("chat.startup");
          }
          await page.getByText(historyText, { exact: true }).waitFor();
          await expect
            .poll(() =>
              page.evaluate(() =>
                (window as TraceWindow).startupPaintTrace.seen.includes("transcript"),
              ),
            )
            .toBe(true);
          const trace = await page.evaluate(() => (window as TraceWindow).startupPaintTrace);
          expect(trace.seen).toEqual(
            expect.arrayContaining(["identity", "sessions", "header", "composer", "transcript"]),
          );
          expect(trace.reveals).toBeLessThanOrEqual(2);
          expect(trace.lost).toEqual([]);
          if (!staggered) {
            expect(trace.skeleton, "fast responses must not flash a skeleton").toBe(false);
          } else {
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
      await page.getByText("Session not found", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Go to main session", exact: true }).click();
      await page.getByText(historyText, { exact: true }).waitFor();
      expect(await page.locator(".connect-splash").count()).toBe(0);
    });
  });

  it("keeps chat available with a recovery action when the sidebar module fails", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await page.route("**/components/app-sidebar.ts*", (route) => route.abort());
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: historyText }] }],
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await gateway.waitForRequest("chat.startup");
      await page.getByText(historyText, { exact: true }).waitFor();
      await page.locator(".lazy-view-error__action").waitFor();
      expect(await page.locator(".connect-splash").count()).toBe(0);
      expect(await page.locator(".shell").getAttribute("inert")).toBeNull();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.locator(".lazy-view-error__action").waitFor({ state: "detached" });
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Continue without the sidebar");
      expect(await page.locator(".lazy-view-error__action").count()).toBe(0);
    });
  });
});
