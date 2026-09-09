import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { capturePhaseBudget, guardPhaseBudget, readPhaseWriter, evaluatePhaseBudget } from "./phase-budget.mjs";

import {cpuQuotaPercent, requirePhaseCpuQuota} from "./cpu-admission.mjs";
import { exportTerminalEvidence, saveDurableJson } from "./terminal-export.mjs";

const [mode, directory, operation, ...args] = process.argv.slice(2);
const cgroup = `/sys/fs/cgroup${fs.readFileSync("/proc/self/cgroup", "utf8").trim().slice(3)}`;
const save = (name, value) => saveDurableJson(directory, name, value);
if (mode === "stop") {
  const terminal = exportTerminalEvidence({ directory, cgroup, readPhaseWriter, evaluatePhaseBudget });
  if (Object.keys(terminal.errors).length !== 0 || terminal.stopped !== true || terminal.accountingStatus !== "complete" || !terminal.charge?.passed) process.exitCode = 1;
} else {
  assert.equal(mode, "run");
  const plan = JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8"));
  assert.equal(fs.readFileSync(path.join(cgroup, "memory.max"), "utf8").trim(), "8589934592");
  assert.equal(fs.readFileSync(path.join(cgroup, "memory.swap.max"), "utf8").trim(), "0");
  const baseline = capturePhaseBudget({ phaseId: plan.id, limitBytes: plan.limitBytes, prechargedBytes: plan.prechargedBytes,
    cancellationMarginBytes: 536870912, writerPaths: [cgroup] });
  save("baseline.json", baseline);
  const writes = guardPhaseBudget(baseline);
  const sample = () => {
    const cpu = {expectedPercent: cpuQuotaPercent(plan.phase), cpuMax: fs.readFileSync(path.join(cgroup, "cpu.max"), "utf8"), cpuBurst: fs.readFileSync(path.join(cgroup, "cpu.max.burst"), "utf8")};
    if (!fs.existsSync(path.join(directory, "cpu-quota.json"))) save("cpu-quota.json", cpu);
    assert.equal(plan.cpuQuotaPercent, cpu.expectedPercent);
    requirePhaseCpuQuota(plan.phase, cpu.cpuMax, cpu.cpuBurst);
    assert.ok(Date.now() < plan.deadline, "Android catalog phase deadline reached");
    const available = Number(fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB$/mu)[1]) * 1024;
    assert.ok(available >= 4294967296, "Retain hosted4GiB host reserve");
    const disk = fs.statfsSync(directory);
    assert.ok(disk.bavail * disk.bsize >= 4294967296, "Retain hosted4GiB disk reserve");
    const charge = writes();
    assert.ok(charge.chargedBytes + 1048576 < plan.limitBytes - 536870912);
    fs.appendFileSync(path.join(directory, "resources.jsonl"), JSON.stringify({ at: new Date().toISOString(), available, cpu, charge }) + "\n");
  };
  sample();
  if (operation === "control") {
    const fd = fs.openSync(path.join(directory, "control.bin"), "wx");
    fs.writeSync(fd, Buffer.alloc(4096)); fs.fsyncSync(fd); fs.closeSync(fd);
    sample();
    save("monitor-death-intent.json", { pid: process.pid });
    process.kill(process.pid, "SIGKILL");
  } else {
    const child = spawn(operation, args, { stdio: "inherit", env: process.env });
    save("allocator.json", { pid: child.pid, operation, args });
    const timer = setInterval(() => { try { sample(); } catch (error) { save("guard-stop.json", { error: String(error), observation: error.observation ?? null }); process.exit(1); } }, 250);
    child.once("error", error => { save("spawn-error.json", { error: String(error) }); process.exit(1); });
    child.once("close", (code, signal) => {
      clearInterval(timer);
      save("result.json", { code, signal });
      process.exitCode = code ?? 70;
      try { sample(); } catch (error) {
        save("final-sample-error.json", { error: String(error), observation: error.observation ?? null });
        if (process.exitCode === 0) process.exitCode = 1;
      }
    });
  }
}
