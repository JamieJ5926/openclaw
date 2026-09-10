import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

export function defineSessionGroupSelectionTests() {
  it("fences late group reads and writes across A to B to A selection", async () => {
    const oldRead = createDeferred<{ groups: Array<{ name: string; position: number }> }>();
    const oldWrite = createDeferred<{
      ok: boolean;
      groups: Array<{ name: string; position: number }>;
    }>();
    let mainReads = 0;
    const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
      if (method === "sessions.groups.put") {
        return oldWrite.promise;
      }
      if (method === "sessions.groups.list") {
        if (params?.agentId === "main" && ++mainReads === 1) {
          return oldRead.promise;
        }
        return {
          groups: [{ name: params?.agentId === "main" ? "Current A" : "Only B", position: 0 }],
        };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      return {};
    });
    const { sessions, selection, connect } = createSubscriptionHydrationHarness(request, "main");
    try {
      connect();
      const pendingRead = sessions.groupsLoad();
      expect(request).toHaveBeenCalledWith("sessions.groups.list", { agentId: "main" });
      selection.set("writer");
      await sessions.groupsLoad();
      expect(sessions.state.groups).toEqual(["Only B"]);
      selection.set("main");
      await sessions.groupsLoad();
      oldRead.resolve({ groups: [{ name: "Stale A", position: 0 }] });
      await pendingRead;
      expect(sessions.state.groups).toEqual(["Current A"]);
      const pendingWrite = sessions.groupsPut(["Old write"]);
      selection.set("writer");
      await sessions.groupsLoad();
      selection.set("main");
      await sessions.groupsLoad();
      oldWrite.resolve({ ok: true, groups: [{ name: "Old write", position: 0 }] });
      await expect(pendingWrite).resolves.toBe("stale");
      expect(sessions.state.groups).toEqual(["Current A"]);
      expect(request).toHaveBeenCalledWith("sessions.groups.put", {
        agentId: "main",
        names: ["Old write"],
      });
    } finally {
      sessions.dispose();
    }
  });
}
