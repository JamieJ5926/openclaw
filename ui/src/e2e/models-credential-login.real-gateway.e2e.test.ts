import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const pluginId = "credential-login-fixture";
const providerId = "credential-fixture";
const choiceId = "credential-fixture-secret";
const secret = "synthetic-login-secret";
let instance: OpenClawTestInstance;
let pluginDir: string;
const defaults = {
  model: "retained/model",
  modelPolicy: { allow: ["retained/*"] },
};
const suite = createControlUiE2eSuite({
  name: "Models credential-only login",
  startServerBeforeBrowser: true,
  async startServer() {
    pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-login-plugin-"));
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@example/credential-login-fixture",
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"], setupEntry: "./index.cjs" },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        name: "Credential login fixture",
        providers: [providerId],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        providerAuthChoices: [
          {
            provider: providerId,
            method: "secret",
            choiceId,
            choiceLabel: "Fixture sign-in",
            appGuidedSecret: true,
            onboardingScopes: ["text-inference"],
          },
        ],
      }),
    );
    // This is a config-origin plugin with a real manifest and auth method. The
    // Gateway and browser use their normal entry points without an injected runner.
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `
module.exports = { id: "${pluginId}", register(api) {
  api.registerProvider({ id: "${providerId}", label: "Credential fixture", auth: [
    { id: "unselected", label: "Other method", kind: "custom", async run() {
      throw new Error("An unselected auth method ran");
    } },
    { id: "secret", label: "Fixture sign-in", kind: "api_key", async run(ctx) {
      const key = await ctx.prompter.text({ message: "Synthetic sign-in secret", sensitive: true });
      ctx.signal?.throwIfAborted();
      return {
        profiles: [{ profileId: "${providerId}:default", credential: { type: "api_key", provider: "${providerId}", key } }],
        defaultModel: "${providerId}/starter", replaceDefaultModels: true,
        configPatch: {
          agents: { defaults: { model: "${providerId}/starter", models: {}, modelPolicy: { allow: ["*"] } } },
          tools: { profile: "full" },
          models: { providers: { "${providerId}": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [] } } }
        }
      };
    } }
  ] });
} };
`,
    );
    instance = await createOpenClawTestInstance({
      name: "models-credential-login",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: { ownership: "explicit", defaults, entries: { main: {} } },
        tools: { profile: "messaging" },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            retained: {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              models: [{ id: "model", name: "Retained model" }],
            },
          },
        },
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginDir] },
          entries: { [pluginId]: { enabled: true } },
        },
      },
    });
    try {
      await instance.startGateway();
      const pid = instance.child?.pid;
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        close: async () => {
          try {
            await instance.cleanup();
          } finally {
            await fs.writeFile(
              path.join(suite.artifactDir, "gateway-lifecycle.json"),
              JSON.stringify(
                {
                  pid,
                  port: instance.port,
                  exitCode: instance.child?.exitCode,
                  signalCode: instance.child?.signalCode,
                  logs: redact(instance.logs()),
                },
                null,
                2,
              ),
            );
            await fs.rm(pluginDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await instance.cleanup();
      await fs.rm(pluginDir, { recursive: true, force: true });
      throw error;
    }
  },
});

function redact(value: string): string {
  return value
    .replaceAll(instance.gatewayToken, "[synthetic gateway token]")
    .replaceAll(instance.hookToken, "[synthetic hook token]")
    .replaceAll(secret, "[synthetic sign-in secret]")
    .replaceAll(instance.homeDir, "[fixture home]")
    .replaceAll(instance.stateDir, "[fixture state]")
    .replaceAll(pluginDir, "[fixture plugin]")
    .replaceAll(process.cwd(), "[source checkout]");
}

suite.define(() => {
  it("cancels an owned login, denies peers, then saves credentials without activating a model", async () => {
    const commands: unknown[] = [];
    const frames: Array<{ direction: string; frame: unknown }> = [];
    const pages: Array<{ stage: string; text: string }> = [];
    const browserMethods: string[] = [];
    let sessionId: string | undefined;
    let stage = "read initial status";
    const call = async (method: string, params: Record<string, unknown>, success = true) => {
      const result = await instance.cli([
        "gateway",
        "call",
        method,
        "--json",
        "--params",
        JSON.stringify(params),
      ]);
      commands.push({ method, params, ...result });
      if (success) expect(result.code, result.stderr).toBe(0);
      else expect(result.code, result.stdout).not.toBe(0);
      return result;
    };
    const status = async (): Promise<ModelAuthStatusResult> =>
      JSON.parse((await call("models.authStatus", { agentId: "main" })).stdout);
    try {
      const before = await status();
      expect(
        before.providerCapabilities?.find((row) => row.provider === providerId)?.accessOptions,
      ).toEqual([{ id: choiceId, label: "Fixture sign-in", mode: "login" }]);
      expect(before.providers.find((row) => row.provider === providerId)?.profiles ?? []).toEqual(
        [],
      );
      const beforeConfig = await fs.readFile(instance.configPath, "utf8");
      const refused = await call(
        "models.authLogin",
        { agentId: "main", sessionId: "removed-choice", authChoice: "removed-choice" },
        false,
      );
      expect(refused.stderr).toContain("sign-in option is unavailable");
      expect(await fs.readFile(instance.configPath, "utf8")).toBe(beforeConfig);
      const handoff = await instance.cli(["dashboard", "--json"]);
      expect(handoff.code, handoff.stderr).toBe(0);
      const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
      const url = new URL(browserUrl);
      url.pathname = "/settings/model-providers";
      url.search = "?view=connect";
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const capture = async () => {
            pages.push({ stage, text: await page.locator("body").innerText() });
            await page.screenshot({ path: path.join(suite.artifactDir, `${stage}.png`) });
          };
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => {
              const frame: { type: string; method?: string; params?: { sessionId?: string } } =
                JSON.parse(payload.toString());
              frames.push({ direction: "sent", frame });
              if (frame.type === "req" && frame.method) {
                browserMethods.push(frame.method);
                if (frame.method === "models.authLogin") sessionId = frame.params?.sessionId;
              }
            });
            socket.on("framereceived", ({ payload }) =>
              frames.push({ direction: "received", frame: JSON.parse(payload.toString()) }),
            );
          });
          try {
            stage = "available-choice";
            await page.goto(url.href);
            await waitForControlUiGatewayReady(page);
            const signIn = page.locator(`[data-model-provider-login="${choiceId}"]`);
            await expect.poll(() => signIn.isEnabled()).toBe(true);
            await capture();
            stage = "owned-prompt";
            await signIn.click();
            const dialog = page.getByRole("dialog");
            await expect.poll(() => dialog.innerText()).toContain("Provider sign-in");
            await capture();
            expect(sessionId).toBeTypeOf("string");
            for (const method of ["wizard.status", "wizard.next", "wizard.cancel"]) {
              const denied = await call(method, { sessionId }, false);
              expect(denied.stderr).toContain("wizard not found");
            }
            const duplicate = await call(
              "models.authLogin",
              { agentId: "main", sessionId, authChoice: choiceId },
              false,
            );
            expect(duplicate.stderr).toContain("wizard session already exists");
            stage = "cancelled-before-secret";
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect.poll(() => dialog.count()).toBe(0);
            await expect.poll(() => signIn.isEnabled()).toBe(true);
            const cancelled = await status();
            expect(
              cancelled.providers.find((row) => row.provider === providerId)?.profiles ?? [],
            ).toEqual([]);
            expect(await fs.readFile(instance.configPath, "utf8")).toBe(beforeConfig);
            await capture();
            stage = "secret-prompt";
            await signIn.click();
            await dialog.getByRole("button", { name: "Continue", exact: true }).click();
            const input = dialog.getByLabel("Synthetic sign-in secret", { exact: true });
            await input.waitFor({ state: "visible" });
            await capture();
            await input.fill(secret);
            stage = "saved-without-activation";
            await dialog.getByRole("button", { name: "Submit", exact: true }).click();
            await expect
              .poll(() => page.locator("body").innerText(), { timeout: 30_000 })
              .toContain("Sign-in saved. Your default model is unchanged.");
            await capture();
            const after = await status();
            expect(after.providers.find((row) => row.provider === providerId)?.profiles).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ profileId: `${providerId}:default`, type: "api_key" }),
              ]),
            );
            const config = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
            commands.push({ observation: "configuration-after-login", config });
            expect(config.agents.defaults).toEqual(JSON.parse(beforeConfig).agents.defaults);
            expect(config.tools).toEqual(JSON.parse(beforeConfig).tools);
            expect(config.models.providers.retained).toEqual(
              JSON.parse(beforeConfig).models.providers.retained,
            );
            expect(config.models.providers[providerId].baseUrl).toBe("http://127.0.0.1:9/v1");
            expect(browserMethods).not.toContain("models.probe");
            expect(browserMethods).not.toContain("openclaw.setup.auth.start");
            expect(browserMethods).not.toContain("openclaw.setup.activate.start");
          } finally {
            stage = `${stage}-final`;
            await capture();
          }
        },
      );
    } finally {
      await fs.writeFile(
        path.join(suite.artifactDir, "public-observations.json"),
        redact(JSON.stringify({ stage, commands, frames, pages }, null, 2)),
      );
    }
  }, 120_000);
});
