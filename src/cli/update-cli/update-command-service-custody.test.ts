import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as entrypoints from "../../daemon/gateway-entrypoint.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "native command admits only a capable target receiver: supported=%s",
  async (supported) => {
    const scratch = dirs.make("native-command-custody-");
    const root = await fs.realpath(process.cwd());
    const control = path.join(scratch, "control");
    await fs.mkdir(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const entrypoint = path.join(scratch, "entry.mjs");
    const effect = path.join(scratch, "effect");
    const receipt = path.join(scratch, "receipt");
    const probeReceipt = path.join(scratch, "probe-receipt");
    await fs.writeFile(
      entrypoint,
      `
    await import(${JSON.stringify(new URL("../../../scripts/tsx.mjs", import.meta.url).href)});
    const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(new URL("../daemon-cli/update-executor.ts", import.meta.url).href)});
    const {execFileUtf8}=await import(${JSON.stringify(new URL("../../daemon/exec-file.ts", import.meta.url).href)});
    const fs=await import("node:fs");
    const mode=process.argv[process.argv.indexOf("--update-executor")+1];
    if(mode==="check") {
      const {DatabaseSync}=await import("node:sqlite");
      const {createManagedHandoffLeaseStore}=await import(${JSON.stringify(new URL("../../infra/update-managed-service-handoff-lease.ts", import.meta.url).href)});
      const databasePath=${JSON.stringify(path.join(control, "managed-update-handoffs.sqlite"))};
      const db=new DatabaseSync(databasePath,{readOnly:true});
      const rows=db.prepare("SELECT install_root, owner, payload_json FROM managed_update_handoffs").all();
      db.close();
      const row=rows.find(row=>JSON.parse(row.payload_json).executor.pid===process.pid);
      const lease=row?JSON.parse(row.payload_json):null;
      const store=createManagedHandoffLeaseStore({databasePath,serviceManagerEnv:process.env});
      fs.writeFileSync(${JSON.stringify(probeReceipt)},JSON.stringify({pid:process.pid,key:row?.install_root,
        owner:row?.owner,helper:lease?.helper.pid,boundStart:lease?.executor.startIdentity,
        actualStart:store.readProcessStartIdentity(process.pid)}));
    }
    if(!${supported}) { process.stderr.write("unknown option --update-executor"); process.exitCode=1; }
    else await runGatewayServiceUpdateCommand(mode,"stop",async()=>{
      fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,parent:process.ppid,noRespawn:process.env.OPENCLAW_NO_RESPAWN}));
      const result=await execFileUtf8(process.execPath,["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(effect)},"owned")`)}]);
      if(result.code!==0)throw new Error(result.stderr);
      process.stdout.write(JSON.stringify({action:"stop",ok:true,result:"stopped"}));
    });
  `,
    );
    vi.spyOn(entrypoints, "resolveGatewayInstallEntrypoint").mockResolvedValue(entrypoint);
    const runId = randomUUID();
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      return await runUpdatedInstallGatewayCommand(
        {
          result: { root },
          opts: { json: true, run: { runId, env: process.env, executorFence: fence } },
          invocationEnv: process.env,
          timeoutMs: 20_000,
        },
        "stop",
      );
    });
    if (supported) {
      expect(await work).toBe("accepted");
      expect(await fs.readFile(effect, "utf8")).toBe("owned");
      const observed = JSON.parse(await fs.readFile(receipt, "utf8"));
      expect(observed).toMatchObject({ parent: process.pid, noRespawn: "1" });
      expect(observed.pid).not.toBe(process.pid);
    } else {
      await expect(work).rejects.toThrow("cannot fence");
      await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const probe = JSON.parse(await fs.readFile(probeReceipt, "utf8"));
    expect(probe).toMatchObject({ owner: runId, helper: process.pid });
    expect(probe.pid).not.toBe(process.pid);
    expect(probe.key.startsWith(root + "/.openclaw-update-child-")).toBe(true);
    expect(probe.boundStart).toBe(probe.actualStart);
    expect(createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
  },
);
