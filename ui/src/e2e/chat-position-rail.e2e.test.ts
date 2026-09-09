import { expect, it } from "vitest";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../pages/chat/sidebar-layout.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "tracks reader position and keyboard jumps in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
          ...(captureUiProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1440 } } }
            : {}),
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const messages = Array.from({ length: 240 }, (_, index) => ({
            __openclaw: { id: `position-rail-${index}`, seq: index + 1 },
            content:
              index === 0
                ? [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=",
                      },
                    },
                  ]
                : [
                    {
                      text:
                        index === 27
                          ? "![Preview](data:image/gif;base64,R0lGODlhAAQABIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)"
                          : `Transcript **checkpoint ${index}** with \`code\` and *emphasis*.`,
                      type: "text",
                    },
                  ],
            role: index % 2 === 0 ? "user" : "assistant",
            timestamp: Date.UTC(2026, 8, 4, 12, index),
          }));
          await installMockGateway(page, { historyMessages: messages });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(
            ({ key, mode }) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  ...JSON.parse(localStorage.getItem(key) ?? "{}"),
                  theme: mode,
                  themeMode: mode,
                }),
              );
            },
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: colorScheme },
          );
          await page.goto(`${suite.server.baseUrl}chat`);
          const transcript = page.locator(".chat-thread");
          await transcript
            .locator(".chat-virtual-row")
            .getByText("Transcript checkpoint 239 with code and emphasis.", { exact: true })
            .waitFor();

          const rail = page.locator(".chat-position-rail");
          const markers = rail.locator(".chat-position-rail__marker");
          const preview = rail.locator(".chat-position-rail__preview-copy");
          const track = rail.locator(".chat-position-rail__track");
          const sampledIds = [0, 27, 53, 80, 106, 133, 159, 186, 212, 239];
          await markers.first().waitFor();
          await expect.poll(() => markers.count()).toBe(10);
          expect(
            await markers.evaluateAll((items) =>
              items.map((item) => item.getAttribute("data-position-marker-id")),
            ),
          ).toEqual(sampledIds.map((index) => `position-rail-${index}`));
          const trackBounds = (await track.boundingBox())!;
          const transcriptBounds = (await transcript.boundingBox())!;
          const contentBounds = (await transcript.locator(".chat-thread-inner").boundingBox())!;
          expect(trackBounds.x).toBeGreaterThan(contentBounds.x + contentBounds.width);
          expect(trackBounds.x + trackBounds.width).toBeLessThan(
            transcriptBounds.x + transcriptBounds.width,
          );
          expect(trackBounds.height).toBeCloseTo(210, 2);
          const checkMarkerTargets = async (pitch: number) => {
            const bounds = await markers.evaluateAll((items) =>
              items.map((item) => item.getBoundingClientRect().toJSON()),
            );
            for (let index = 0; index < bounds.length; index++) {
              const current = bounds[index]!;
              expect(current.width).toBeCloseTo(26, 2);
              expect(current.height).toBeCloseTo(Math.min(26, pitch), 1);
              if (index > 0) {
                const previous = bounds[index - 1]!;
                expect(current.y - previous.y).toBeCloseTo(pitch, 1);
                expect(current.y).toBeGreaterThanOrEqual(previous.bottom - 0.02);
              }
            }
            // Test actual hit routing, not just CSS boxes: neither edge may
            // resolve to the neighboring landmark after the spacing shrinks.
            expect(
              await markers.evaluateAll((items) =>
                items.every((item) => {
                  const rect = item.getBoundingClientRect();
                  return [rect.top + 1, rect.bottom - 1].every(
                    (y) =>
                      document
                        .elementFromPoint(rect.x + rect.width / 2, y)
                        ?.closest(".chat-position-rail__marker") === item,
                  );
                }),
              ),
            ).toBe(true);
          };
          await checkMarkerTargets(21);
          expect(
            await markers.evaluateAll((items) =>
              items.map((item) => {
                const rect = item
                  .querySelector(".chat-position-rail__dot")!
                  .getBoundingClientRect();
                return [rect.width, rect.height];
              }),
            ),
          ).toEqual(Array.from({ length: 10 }, () => [9, 9]));
          expect(await markers.first().getAttribute("aria-label")).toContain("1 of 10");
          expect(await markers.last().getAttribute("aria-label")).toContain("10 of 10");
          expect(await preview.count()).toBe(0);
          expect(await rail.locator('[role="status"]').count()).toBe(0);
          await captureUiProof(suite, page, "chat-position-rail", "idle.png");

          const currentMarkerIndex = () =>
            markers.evaluateAll((items) =>
              items.findIndex((item) => item.getAttribute("aria-current") === "true"),
            );
          const flashPaint = (index: number) =>
            transcript
              .locator(`.chat-bubble[data-entry-id="position-rail-${index}"]`)
              .evaluate((element) => {
                const overlay = getComputedStyle(element, "::after");
                return {
                  visible: overlay.content !== "none" && Number.parseFloat(overlay.opacity) > 0,
                  animated: overlay.animationName !== "none",
                  outline: getComputedStyle(element).outlineStyle,
                };
              });
          const targetIsVisible = (index: number) =>
            transcript
              .locator(`.chat-bubble[data-entry-id="position-rail-${index}"]`)
              .evaluate((element) => {
                const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                const bubble = element.getBoundingClientRect();
                return bubble.top >= viewport.top && bubble.bottom <= viewport.bottom;
              });
          const firstMarkerNode = await markers.first().elementHandle();
          await expect.poll(currentMarkerIndex).toBe(9);
          await transcript.hover();
          await page.mouse.wheel(0, -100_000);
          await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
          await expect.poll(currentMarkerIndex).toBe(0);
          // The active landmark represents the interval before the next sample,
          // even when that landmark's own message is no longer in the viewport.
          await page.mouse.wheel(0, 600);
          await expect
            .poll(() =>
              transcript.evaluate((element) => {
                const first = element.querySelector('[data-entry-id="position-rail-0"]');
                return (
                  !first ||
                  first.getBoundingClientRect().bottom <= element.getBoundingClientRect().top
                );
              }),
            )
            .toBe(true);
          await expect.poll(currentMarkerIndex).toBe(0);
          expect(await firstMarkerNode!.evaluate((element) => element.isConnected)).toBe(true);
          await page.mouse.wheel(0, -100_000);
          await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);

          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.focus();
          await markers.nth(1).hover();
          const previewImage = preview.locator("img");
          await expect
            .poll(() => previewImage.evaluate((image: HTMLImageElement) => image.naturalHeight))
            .toBe(1024);
          expect(
            await preview.evaluate(
              (element) =>
                element.getBoundingClientRect().height /
                Number.parseFloat(getComputedStyle(element).lineHeight),
            ),
          ).toBeLessThanOrEqual(3.01);
          await page.mouse.move(600, 100);
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 106");
          expect(await preview.locator("strong").textContent()).toBe("checkpoint 106");
          expect(await preview.locator("code").textContent()).toBe("code");
          expect(await preview.locator("em").textContent()).toBe("emphasis");
          expect(await preview.getAttribute("inert")).not.toBeNull();
          await expect
            .poll(() =>
              markers
                .nth(4)
                .locator(".chat-position-rail__tick")
                .evaluate((element) => Number.parseFloat(getComputedStyle(element).width)),
            )
            .toBeGreaterThan(8);
          expect(
            await markers
              .nth(4)
              .locator(".chat-position-rail__dot")
              .evaluate((element) => getComputedStyle(element).boxShadow),
          ).not.toBe("none");
          expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
          await captureUiProof(suite, page, "chat-position-rail", "scroll-follow-hover.png");

          const previewBounds = (await preview.boundingBox())!;
          await page.mouse.move(
            previewBounds.x + previewBounds.width / 2,
            previewBounds.y + previewBounds.height / 2,
            { steps: 20 },
          );
          expect(await preview.textContent()).toContain("Transcript checkpoint 106");
          await captureUiProof(suite, page, "chat-position-rail", "hover-reading.png");
          await page.keyboard.press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          await page.mouse.move(600, 100);
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 106");
          await page.mouse.move(600, 100);
          await expect.poll(() => preview.count()).toBe(0);
          await markers.first().hover();
          await expect
            .poll(async () => (await preview.textContent())?.trim())
            .toBe("Preview unavailable");
          expect(await preview.boundingBox()).not.toBeNull();
          await page.mouse.move(600, 100);

          await markers.nth(5).focus();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 133");
          await markers.nth(5).press("ArrowDown");
          await expect
            .poll(() =>
              page.evaluate(() => document.activeElement?.getAttribute("data-position-marker-id")),
            )
            .toBe("position-rail-159");
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 159");
          expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
          expect(
            await markers.nth(6).evaluate((element) => getComputedStyle(element).boxShadow),
          ).not.toBe("none");
          await markers.nth(6).press("Enter");
          await expect.poll(() => targetIsVisible(159)).toBe(true);
          await expect.poll(currentMarkerIndex).toBe(6);
          await expect
            .poll(() => flashPaint(159))
            .toEqual({ visible: true, animated: true, outline: "none" });
          await captureUiProof(suite, page, "chat-position-rail", "keyboard-jump.png");
          await expect.poll(async () => (await flashPaint(159)).visible).toBe(false);

          // Both sides of an adjacent pair must activate their own message.
          for (const [index, edge] of [
            [4, "bottom"],
            [5, "top"],
          ] as const) {
            const bounds = (await markers.nth(index).boundingBox())!;
            await page.mouse.move(
              bounds.x + bounds.width / 2,
              edge === "top" ? bounds.y + 1 : bounds.y + bounds.height - 1,
            );
            await page.mouse.down();
            const pressedBounds = (await markers.nth(index).boundingBox())!;
            await page.mouse.up();
            expect(pressedBounds.y).toBeCloseTo(bounds.y, 2);
            const messageIndex = sampledIds[index]!;
            await expect.poll(() => targetIsVisible(messageIndex)).toBe(true);
            await expect.poll(currentMarkerIndex).toBe(index);
            await expect
              .poll(() => flashPaint(messageIndex))
              .toEqual({ visible: true, animated: true, outline: "none" });
            await captureUiProof(
              suite,
              page,
              "chat-position-rail",
              `jump-flash-${messageIndex}.png`,
            );
            await expect.poll(async () => (await flashPaint(messageIndex)).visible).toBe(false);
          }
          await markers.nth(5).press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          await markers.nth(5).press("Home");
          await expect
            .poll(() => markers.first().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.first().press(" ");
          await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
          await expect.poll(currentMarkerIndex).toBe(0);
          await markers.first().press("End");
          await markers.last().press("Enter");
          await expect.poll(currentMarkerIndex).toBe(9);
          await expect
            .poll(() => flashPaint(239))
            .toEqual({ visible: true, animated: true, outline: "none" });
          await expect.poll(async () => (await flashPaint(239)).visible).toBe(false);

          // A shorter eligible pane halves the original adaptive track too.
          await page.setViewportSize({ height: 700, width: 1440 });
          await markers.first().waitFor({ state: "visible" });
          const expectedTrackHeight = await transcript.evaluate((element) => {
            const style = getComputedStyle(element);
            const contentHeight =
              element.getBoundingClientRect().height -
              Number.parseFloat(style.borderTopWidth) -
              Number.parseFloat(style.borderBottomWidth) -
              Number.parseFloat(style.paddingTop) -
              Number.parseFloat(style.paddingBottom);
            return Math.min(210, (contentHeight - 48) / 2);
          });
          await expect
            .poll(async () => (await track.boundingBox())!.height)
            .toBeCloseTo(expectedTrackHeight, 1);
          await checkMarkerTargets(expectedTrackHeight / 10);
          await page.setViewportSize({ height: 500, width: 1440 });
          await markers.first().waitFor({ state: "hidden" });
          await page.setViewportSize({ height: 900, width: 1440 });
          await markers.first().waitFor({ state: "visible" });
          await transcript.evaluate((element) => {
            element.style.width = "800px";
          });
          await markers.first().waitFor({ state: "hidden" });
          await transcript.evaluate((element) => {
            element.style.removeProperty("width");
          });
          await markers.first().waitFor({ state: "visible" });
          await page.setViewportSize({ height: 900, width: 900 });
          await markers.first().waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "narrow-pane.png");
          await page.setViewportSize({ height: 844, width: 390 });
          await markers.first().waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "mobile.png");
          await page.setViewportSize({ height: 900, width: 1440 });
          await markers.first().waitFor({ state: "visible" });
          await page.emulateMedia({ reducedMotion: "reduce" });
          for (const part of ["dot", "tick"]) {
            expect(
              await markers
                .first()
                .locator(`.chat-position-rail__${part}`)
                .evaluate((element) =>
                  Number.parseFloat(getComputedStyle(element).transitionDuration),
                ),
            ).toBeLessThanOrEqual(0.00001);
          }
          await markers.last().click();
          await expect
            .poll(() => flashPaint(239))
            .toEqual({ visible: true, animated: false, outline: "none" });
          await expect.poll(async () => (await flashPaint(239)).visible).toBe(false);

          // Saved widths can consume the gutter even in a wide desktop pane.
          for (const width of ["100%", "none", "95%", "48rem"]) {
            await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
            const widthInput = page.locator("[data-settings-chat-message-width]");
            await widthInput.fill(width);
            await widthInput.press("Tab");
            await expect
              .poll(() =>
                page.evaluate(
                  (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
                  controlUiBundledSettingsStorageKey(suite.server.baseUrl),
                ),
              )
              .toBe(width);
            await page.goto(`${suite.server.baseUrl}chat`);
            await transcript.locator('.chat-bubble[data-entry-id="position-rail-239"]').waitFor();
            await expect
              .poll(() =>
                transcript.evaluate((element) =>
                  getComputedStyle(element).getPropertyValue("--chat-thread-max-width").trim(),
                ),
              )
              .toBe(width);
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
            if (width === "48rem") {
              const inner = await transcript.locator(".chat-thread-inner").boundingBox();
              const marker = await markers.first().boundingBox();
              expect(marker!.x - (inner!.x + inner!.width)).toBeGreaterThanOrEqual(8);
            }
            await captureUiProof(
              suite,
              page,
              "chat-position-rail",
              `saved-width-${width.replace("%", "percent")}.png`,
            );
          }
          // A foreign-host commit can change the inner column while the pane's
          // own dimensions stay fixed. Exercise that existing event boundary.
          for (const width of ["95%", "48rem"]) {
            await transcript.evaluate(
              (element, { columnWidth, eventName }) => {
                element.style.setProperty("--chat-thread-max-width", columnWidth);
                element.dispatchEvent(
                  new CustomEvent(eventName, {
                    bubbles: true,
                    detail: { widthChanged: false },
                  }),
                );
              },
              { columnWidth: width, eventName: SIDEBAR_GEOMETRY_COMMIT_EVENT },
            );
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
          }
          await transcript.evaluate((element) =>
            element.style.removeProperty("--chat-thread-max-width"),
          );
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );
});
