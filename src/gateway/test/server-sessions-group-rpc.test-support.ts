import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { putSessionGroups } from "../session-groups.js";
import { rpcReq, testState } from "../test-helpers.js";
import {
  getGatewayConfigModule,
  type setupGatewaySessionsTestHarness,
} from "./server-sessions.test-helpers.js";

export function defineSessionGroupRpcTests({
  createSessionStoreDir,
  openClient,
}: Pick<
  ReturnType<typeof setupGatewaySessionsTestHarness>,
  "createSessionStoreDir" | "openClient"
>) {
  test("group RPCs resolve the system read owner and refuse ambiguous or unknown mutation owners", async () => {
    await createSessionStoreDir();
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, work: {} } };
    testState.agentConfig = { ...testState.agentConfig, systemAgent: { agentId: "work" } };
    const { ws } = await openClient({ scopes: ["operator.write"] });
    type Catalog = {
      agentId: string;
      groups: Array<{ name: string; position: number }>;
      sectionOrder: string[];
    };
    type Defaults = { defaults: Array<{ name: string; cwd?: string; worktree?: boolean }> };
    const catalogs = new Map<string, Catalog>();
    const defaults = new Map<string, Defaults>();
    try {
      const roster = await rpcReq<{ defaultId: string; selectionRequired?: boolean }>(
        ws,
        "agents.list",
        {},
      );
      expect(roster.ok).toBe(true);
      expect(roster.payload).toMatchObject({ defaultId: "main", selectionRequired: true });
      for (const agentId of ["main", "work"]) {
        const created = await rpcReq(ws, "sessions.groups.put", {
          agentId,
          names: ["Shared", `${agentId}-only`],
          sectionOrder: [`category:${agentId}-only`, "category:Shared"],
        });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        const updated = await rpcReq(ws, "sessions.groups.update", {
          agentId,
          name: "Shared",
          cwd: null,
          worktree: agentId === "work",
        });
        expect(updated.ok, JSON.stringify(updated)).toBe(true);
        const listed = await rpcReq<Catalog>(ws, "sessions.groups.list", { agentId });
        expect(listed.ok).toBe(true);
        expect(listed.payload?.agentId).toBe(agentId);
        expect(listed.payload?.groups.map((group) => group.name)).toEqual([
          "Shared",
          `${agentId}-only`,
        ]);
        catalogs.set(agentId, expectDefined(listed.payload, "group catalog"));
        const listedDefaults = await rpcReq<Defaults>(ws, "sessions.groups.defaults", { agentId });
        expect(listedDefaults.ok).toBe(true);
        defaults.set(agentId, expectDefined(listedDefaults.payload, "group defaults"));
      }
      const legacyList = await rpcReq<Catalog>(ws, "sessions.groups.list", {});
      expect(legacyList.ok).toBe(true);
      expect(legacyList.payload).toEqual(catalogs.get("work"));
      const legacyDefaults = await rpcReq<Defaults>(ws, "sessions.groups.defaults", {});
      expect(legacyDefaults.ok).toBe(true);
      expect(legacyDefaults.payload).toEqual(defaults.get("work"));

      const mutations: Array<[string, Record<string, unknown>]> = [
        ["sessions.groups.put", { names: ["Unexpected"] }],
        ["sessions.groups.rename", { name: "Shared", to: "Unexpected" }],
        ["sessions.groups.delete", { name: "Shared" }],
        ["sessions.groups.update", { name: "Shared", cwd: null, worktree: false }],
      ];
      for (const [method, params] of mutations) {
        for (const owner of [{}, { agentId: "missing" }]) {
          const refused = await rpcReq(ws, method, { ...params, ...owner });
          expect(refused.ok, `${method}: ${JSON.stringify(refused)}`).toBe(false);
          expect(refused.error?.code).toBe("INVALID_REQUEST");
        }
      }
      for (const method of ["sessions.groups.list", "sessions.groups.defaults"]) {
        const unknown = await rpcReq(ws, method, { agentId: "missing" });
        expect(unknown.ok).toBe(false);
        expect(unknown.error?.code).toBe("INVALID_REQUEST");
      }
      for (const agentId of ["main", "work"]) {
        const listed = await rpcReq<Catalog>(ws, "sessions.groups.list", { agentId });
        const listedDefaults = await rpcReq<Defaults>(ws, "sessions.groups.defaults", { agentId });
        expect(listed.ok).toBe(true);
        expect(listedDefaults.ok).toBe(true);
        expect(listed.payload).toEqual(catalogs.get(agentId));
        expect(listedDefaults.payload).toEqual(defaults.get(agentId));
      }
    } finally {
      ws.close();
      // Canonical group catalogs outlive each case's custom session-store path.
      const { getRuntimeConfig } = await getGatewayConfigModule();
      const cfg = getRuntimeConfig();
      for (const agentId of ["main", "work"]) {
        putSessionGroups({ cfg, agentId, names: [], sectionOrder: [] });
      }
    }
  });
}
