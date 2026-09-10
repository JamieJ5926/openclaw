import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import * as processTree from "../../process/child-process-tree.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as pidAlive from "../../shared/pid-alive.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["healthy", "spawner-settled", "root-replaced", "spawner-replaced"] as const)(
  "nested native child keeps original and immediate authority: %s",
  async (fault) => {
    const root = fs.realpathSync(dirs.make("native-nested-owner-"));
    const control = path.join(root, "control");
    fs.mkdirSync(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const proceed = path.join(root, "proceed");
    const effect = path.join(root, "effect");
    const ownerUrl = new URL("./update-command-executor.ts", import.meta.url).href;
    const loader = path.resolve("scripts/tsx.mjs");
    const leaf = `
      import fs from "node:fs";
      import {setTimeout} from "node:timers/promises";
      import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(ownerUrl)};
      const {grant,proceed,effect}=JSON.parse(fs.readFileSync(0,"utf8"));
      await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{
        process.stdout.write(JSON.stringify({ready:true,rootKey:grant.parent.key,spawnerKey:grant.spawner.key})+"\\n");
        while(!fs.existsSync(proceed)) await setTimeout(10);
        fence.assertCurrent();
        fs.writeFileSync(effect,"owned");
      });
    `;
    const intermediate = `
      import fs from "node:fs";
      import {withDelegatedUpdateCommandExecutor,withUpdateCommandExecutorChild} from ${JSON.stringify(ownerUrl)};
      import {runUtf8CommandWithTimeout} from ${JSON.stringify(new URL("../../process/exec.ts", import.meta.url).href)};
      const input=JSON.parse(fs.readFileSync(0,"utf8"));
      await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async fence=>{
        const result=await withUpdateCommandExecutorChild(fence,(grant,beforeInput)=>runUtf8CommandWithTimeout(
          [process.execPath,"--import",${JSON.stringify(loader)},"--input-type=module","-e",${JSON.stringify(leaf)}],
          {input:JSON.stringify({...input,grant}),beforeInput,timeoutMs:15000,killProcessTree:true,
           requireProcessTreeExtinction:true,onOutputChunk:chunk=>{process.stdout.write(chunk);}}));
        if(result.code!==0)throw new Error(result.stderr);
        fence.assertCurrent();
      });
    `;
    const ready = createDeferred<{ rootKey: string; spawnerKey: string }>();
    let output = "";
    let admitted = false;
    const run = withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      const pending = withUpdateCommandExecutorChild(fence, (grant, beforeInput) =>
        runUtf8CommandWithTimeout(
          [process.execPath, "--import", loader, "--input-type=module", "-e", intermediate],
          {
            input: JSON.stringify({ grant, proceed, effect }),
            beforeInput,
            timeoutMs: 20_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            onOutputChunk: (chunk) => {
              output += chunk.toString();
              const line = output.split("\n").find((entry) => entry.startsWith('{"ready":true'));
              if (line) {
                ready.resolve(JSON.parse(line));
              }
            },
          },
        ),
      );
      try {
        const binding = await Promise.race([
          ready.promise,
          pending.then((result) => {
            throw new Error(result.stderr || "Child exited before admission");
          }),
        ]);
        admitted = true;
        expect(binding.rootKey).toBe(root);
        expect(binding.spawnerKey).not.toBe(root);
        const store = createManagedHandoffLeaseStore();
        expect(store.acquire(root, "replacement", { kind: "update" }).kind).toBe("busy");
        if (fault === "spawner-settled") {
          const spawner = store.read(binding.spawnerKey);
          if (spawner.kind !== "current") {
            throw new Error("Missing admitted spawner");
          }
          // Simulate a settled intermediate without killing either real child.
          // Its live descendant must still block release of the spawner row.
          const isDead = pidAlive.isPidDefinitelyDead;
          const isTreeAlive = processTree.isChildProcessTreeAlive;
          const deadSpy = vi
            .spyOn(pidAlive, "isPidDefinitelyDead")
            .mockImplementation((pid) => pid === spawner.lease.executor.pid || isDead(pid));
          const treeSpy = vi
            .spyOn(processTree, "isChildProcessTreeAlive")
            .mockImplementation(
              (child) => child.pid !== spawner.lease.executor.pid && isTreeAlive(child),
            );
          try {
            expect(
              store.release(spawner.lease),
              "live descendant retains intermediate custody",
            ).toBe(false);
          } finally {
            treeSpy.mockRestore();
            deadSpy.mockRestore();
          }
        }
        if (fault === "root-replaced" || fault === "spawner-replaced") {
          const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
          try {
            db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
              "revoked",
              fault === "root-replaced" ? root : binding.spawnerKey,
            );
          } finally {
            db.close();
          }
        }
      } finally {
        fs.writeFileSync(proceed, "go");
      }
      const result = await pending;
      expect(result.code, result.stderr).toBe(0);
    });
    if (fault === "healthy" || fault === "spawner-settled") {
      await run;
      expect(fs.readFileSync(effect, "utf8")).toBe("owned");
      expect(createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
    } else {
      await expect(run).rejects.toThrow();
      expect(admitted, "fault must occur after nested admission").toBe(true);
      expect(fs.existsSync(effect)).toBe(false);
    }
  },
);
