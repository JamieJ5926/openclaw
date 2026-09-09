import type { ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ModelProviderLoginController } from "./login-controller.ts";

function createLoginHarness() {
  const original = new GatewayBrowserClient({ url: "ws://127.0.0.1:1" });
  let client = original;
  let agentId = "main";
  const refresh = vi.fn(async () => {});
  const setMessage = vi.fn();
  const host: ReactiveControllerHost = {
    addController: () => {},
    removeController: () => {},
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const runtimeConfig: Pick<RuntimeConfigCapability, "runExternalMutation"> = {
    async runExternalMutation(task, options) {
      if (options?.canDispatch?.() === false) {
        return { ok: false, reason: "unavailable", error: "Owner changed" };
      }
      return { ok: true, value: await task(client), refresh: { ok: true } };
    },
  };
  const controller = new ModelProviderLoginController(host, {
    getClient: () => client,
    getAgentId: () => agentId,
    getRuntimeConfig: () => runtimeConfig,
    canStart: () => true,
    refresh,
    setMessage,
  });
  return {
    controller,
    original,
    refresh,
    setMessage,
    setAgent: (value: string) => {
      agentId = value;
    },
    setClient: (value: GatewayBrowserClient) => {
      client = value;
    },
  };
}
const option = { id: "fixture-secret", label: "Fixture", mode: "login" as const };

describe("Models provider sign-in owner", () => {
  it.each(["agent", "client"] as const)(
    "does not apply a late success after the %s changes",
    async (change) => {
      const { controller, original, refresh, setMessage, setAgent, setClient } =
        createLoginHarness();
      const started = createDeferred();
      const response = createDeferred<{ done: true; status: "done" }>();
      vi.spyOn(original, "request").mockImplementation(async (method) => {
        if (method !== "models.authLogin") throw new Error(`Unexpected method: ${method}`);
        started.resolve();
        return await response.promise;
      });
      controller.start("fixture", option);
      await started.promise;
      if (change === "agent") setAgent("writer");
      else setClient(new GatewayBrowserClient({ url: "ws://127.0.0.1:2" }));
      controller.reset();
      response.resolve({ done: true, status: "done" });
      await vi.waitFor(() => expect(controller.busy).toBe(false));
      expect(refresh).not.toHaveBeenCalled();
      expect(setMessage).toHaveBeenCalledExactlyOnceWith("fixture", null);
    },
  );

  it("blocks a replacement until the old prompt has released Gateway admission", async () => {
    const { controller, original } = createLoginHarness();
    const statusRequested = createDeferred();
    const released = createDeferred<{ status: "cancelled" }>();
    const request = vi.spyOn(original, "request").mockImplementation(async (method) => {
      if (method === "models.authLogin") return { done: false, status: "running" };
      if (method === "wizard.next")
        return {
          done: false,
          status: "running",
          step: { id: "secret", type: "text", executor: "client" },
        };
      if (method === "wizard.cancel") return { status: "cancelled" };
      if (method === "wizard.status") {
        statusRequested.resolve();
        return await released.promise;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    controller.start("fixture", option);
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "wizard.next")).toBe(true),
    );
    controller.reset();
    await statusRequested.promise;
    controller.start("replacement", option);
    expect(request.mock.calls.filter(([method]) => method === "models.authLogin")).toHaveLength(1);
    expect(controller.busy).toBe(true);
    released.resolve({ status: "cancelled" });
    await vi.waitFor(() => expect(controller.busy).toBe(false));
  });
});
