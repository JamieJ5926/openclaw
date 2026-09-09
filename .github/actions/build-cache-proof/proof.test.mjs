import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import {
  assertIdle,
  cgroupLimits,
  dependencies,
  inventory,
  render,
  runJoined,
  synchronize,
  verifyGroups,
} from "./proof.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cache-proof-guards-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const directory = (name) => {
  const result = path.join(scratch, name);
  fs.mkdirSync(result, { recursive: true });
  return fs.realpathSync(result);
};
const write = (root, name, bytes) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), bytes);
};
const action = parse(fs.readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
const cache = action.runs.steps.find((step) => step.id === "build-all-cache").with;
const workflow = parse(fs.readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
const phaseAction = parse(fs.readFileSync(".github/actions/build-cache-proof/action.yml", "utf8"));
const evaluate = (value, context) =>
  runInNewContext(value.replace(/inputs\.([a-z-]+)/gu, 'inputs["$1"]'), context);

test("root cgroup absence is explicit while child, unreadable, and unmapped limits fail closed", () => {
  const root = directory("cgroup");
  write(root, "cgroup.controllers", "cpu memory cpuset\n");
  write(root, "cpuset.cpus.effective", "0-7\n");
  const rootLimits = [
    root,
    "cpu memory cpuset",
    "absent: hierarchy-root",
    "absent: hierarchy-root",
    "absent: hierarchy-root",
    "0-7",
  ];
  assert.deepEqual(cgroupLimits("0::/\n", root), [rootLimits]);
  for (const [name, value] of Object.entries({
    "cgroup.controllers": "cpu memory cpuset",
    "cpu.max": "800000 100000",
    "memory.max": "34359738368",
    "memory.high": "max",
    "cpuset.cpus.effective": "0-7",
  }))
    write(root, `job/${name}`, `${value}\n`);
  assert.deepEqual(cgroupLimits("0::/job\n", root), [
    [path.join(root, "job"), "cpu memory cpuset", "800000 100000", "34359738368", "max", "0-7"],
    rootLimits,
  ]);
  fs.rmSync(path.join(root, "job/memory.high"));
  assert.throws(() => cgroupLimits("0::/job\n", root), { code: "ENOENT" });
  for (const code of ["EACCES", "EIO"])
    assert.throws(
      () =>
        cgroupLimits("0::/\n", root, (file) => {
          if (file.endsWith("/cpu.max")) throw Object.assign(new Error(code), { code });
          return fs.readFileSync(file, "utf8");
        }),
      { code },
    );
  assert.throws(() => cgroupLimits("0::/../../outside\n", root), /Unmapped/);
  assert.throws(() => cgroupLimits("1:memory:/\n", root), /Missing unified/);
  fs.rmSync(path.join(root, "cpuset.cpus.effective"));
  assert.throws(() => cgroupLimits("0::/\n", root), { code: "ENOENT" });
  fs.rmSync(path.join(root, "cgroup.controllers"));
  assert.throws(() => cgroupLimits("0::/\n", root), { code: "ENOENT" });
});

test("independent reset restores bytes and links, removes generated outputs, and preserves Git/harness", async () => {
  const root = directory("source"),
    baseline = directory("baseline"),
    outside = directory("outside");
  write(root, ".git/marker", "git");
  write(root, ".ci-harness/marker", "harness");
  write(root, "nested/source.mts", "original");
  write(root, "package.json", "{}");
  fs.linkSync(path.join(root, "nested/source.mts"), path.join(root, "hardlink"));
  fs.symlinkSync(".", path.join(root, "self"));
  await synchronize(root, baseline);
  const snapshot = inventory(baseline, root, true);
  write(root, "nested/source.mts", "mutated");
  assert.equal(fs.readFileSync(path.join(baseline, "hardlink"), "utf8"), "original");
  write(outside, "sentinel", "untouched");
  fs.rmSync(path.join(root, "nested"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "nested"));
  write(root, "dist/generated.d.ts", "stale");
  write(root, ".artifacts/build-all-cache/stale", "stale");
  assert.throws(() => inventory(root), /Escaping dependency/);
  await assert.rejects(synchronize(baseline, root, false, { active: "a" }), /did not complete/);
  assert(fs.existsSync(path.join(root, "dist/generated.d.ts")));
  await synchronize(baseline, root);
  assert.equal(await synchronize(baseline, root, true), "");
  assert.equal(inventory(baseline, root, true), snapshot);
  assert.equal(fs.readFileSync(path.join(root, "nested/source.mts"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "untouched");
  assert(!fs.existsSync(path.join(root, "dist")) && !fs.existsSync(path.join(root, ".artifacts")));
  assert.equal(fs.readlinkSync(path.join(root, "self")), ".");
  assert(
    fs.existsSync(path.join(root, ".git/marker")) &&
      fs.existsSync(path.join(root, ".ci-harness/marker")),
  );
  await assert.rejects(synchronize(root, directory("source/inside")), /Overlapping/);
  write(root, ".artifacts/dist-artifacts.lock/owner.json", "{}");
  assert.throws(() => assertIdle(root), /Unreleased/);
  fs.rmSync(path.join(root, ".artifacts/dist-artifacts.lock"), { recursive: true });
  fs.mkdirSync(path.join(root, ".artifacts/plugin-sdk-staging-leftover"));
  assert.throws(() => assertIdle(root), /Unjoined/);
});

test("installed versions are checked against the dependency document, not the pnpm environment document", async () => {
  const root = directory("dependencies");
  write(root, "package.json", "{}");
  write(
    root,
    "scripts/lib/pnpm-lockfile-documents.mjs",
    fs.readFileSync("scripts/lib/pnpm-lockfile-documents.mjs"),
  );
  const names = ["@openclaw/fs-safe", "typescript", "tsx", "tsdown", "yaml"];
  for (const name of names)
    write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.2.3" }));
  write(
    root,
    "pnpm-lock.yaml",
    `---\nlockfileVersion: '9.0'\n---\nimporters:\n  .:\n    dependencies:\n${names.map((name) => `      '${name}': {version: '1.2.3(peer@1)'}`).join("\n")}\n`,
  );
  assert.equal(Object.keys(await dependencies(root)).length, 5);
  write(root, "node_modules/tsx/package.json", '{"version":"9.0.0"}');
  await assert.rejects(dependencies(root), /Wrong installed version: tsx/);
});

test("four ordered phases use isolated canonical prefixes and publish only A and B", () => {
  const bindings = {
    "github.repository": "openclaw/openclaw",
    "inputs.build-all-cache-scope": "proof-123-1",
    "runner.os": "Linux",
    "runner.arch": "X64",
    "inputs.node-version": "24.x",
    "github.run_id": "123",
    "github.run_attempt": "1",
  };
  const keys = ["a", "b"].map((name) =>
    render(cache.key, {
      ...bindings,
      "steps.build-all-topology.outputs.prefix": `topology-${name}-`,
    }),
  );
  const prefixes = render(cache["restore-keys"], {
    ...bindings,
    "steps.build-all-topology.outputs.prefix": "topology-a-",
  })
    .trim()
    .split("\n");
  const newest = [...keys].reverse();
  const select = (values) =>
    values.flatMap((prefix) => newest.filter((key) => key.startsWith(prefix)))[0];
  assert.equal(select(prefixes.slice(1)), keys[1]);
  assert.equal(select(prefixes), keys[0]);
  for (const phase of ["broad", "preferred"])
    assert(!newest.some((key) => key.startsWith(`${keys[0]}-query-${phase}`)));
  assert.throws(() => render("${{ unsupported }}", bindings), /Unexpected canonical/);
  const phases = workflow.jobs["topology-proof"].steps.filter(
    (step) => step.uses === "./.ci-harness/.github/actions/build-cache-proof",
  );
  assert.deepEqual(
    phases.map((step) => step.with.phase),
    ["a", "b", "broad", "preferred"],
  );
  const saves = phaseAction.runs.steps.filter((step) =>
    step.uses?.startsWith("actions/cache/save@"),
  );
  assert.equal(saves.length, 1);
  assert.deepEqual(
    phases
      .filter((step) => evaluate(saves[0].if, { inputs: step.with }))
      .map((step) => step.with.phase),
    ["a", "b"],
  );
  assert.equal(
    phaseAction.runs.steps.find((step) => step.id === "restore").uses,
    "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  );
});

test("proof mode admits one 8-class Linux job, no normal warmer, and no automatic second attempt", () => {
  const proof = workflow.jobs["topology-proof"];
  for (const event of ["push", "schedule", "repository_dispatch", "workflow_dispatch"]) {
    for (const enabled of [false, true])
      for (const attempt of [1, 2]) {
        const context = {
          github: {
            repository: "openclaw/openclaw",
            event_name: event,
            run_attempt: attempt,
            ref: "refs/heads/perf/ci-build-cache-topology-proof-34354161815",
          },
          inputs: { "topology-proof": enabled },
        };
        assert.equal(
          evaluate(proof.if, context),
          enabled && event === "workflow_dispatch" && attempt === 1,
        );
        assert.equal(evaluate(workflow.jobs.warm.if, context), !enabled);
      }
  }
  assert.equal(proof["runs-on"], "blacksmith-8vcpu-ubuntu-2404");
  assert.equal(proof["timeout-minutes"], 30);
  assert(!proof.strategy);
  assert.deepEqual(workflow.jobs.warm.strategy.matrix.platform, ["linux", "macos"]);
  const checkouts = proof.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert(checkouts.every((step) => step.with["persist-credentials"] === false));
  assert.equal(checkouts[0].with.ref, "${{ env.PROOF_SOURCE_SHA }}");
  assert.equal(checkouts[1].with.ref, "${{ github.workflow_sha }}");
  assert.equal(checkouts[1].with.path, ".ci-harness");
  const setup = proof.steps.find((step) => step.uses === "./.github/actions/setup-node-env");
  assert.deepEqual(setup.with, {
    "cache-mode": "restore",
    "dependency-cache": "true",
    "install-bun": "false",
  });
});

test("missing, duplicate, and mixed group observations cannot pass", () => {
  const line = (name, status = "hit") =>
    `[tsdown-unified] ${name}: cache ${status} (fresh-cache)\n`;
  const groups = ["openclaw-dts-base", "openclaw-dts-plugin-sdk-1"];
  assert.equal(verifyGroups(groups.map((name) => line(name)).join(""), groups, "hit").length, 2);
  assert.throws(() => verifyGroups(line(groups[0]), groups, "hit"));
  assert.throws(() => verifyGroups(line(groups[0]) + line(groups[0]), groups, "hit"));
  assert.throws(() => verifyGroups(line(groups[0]) + line(groups[1], "miss"), groups, "hit"));
});

test(
  "joined commands reject nonzero exit, timeout, and oversized output",
  { timeout: 20_000 },
  async () => {
    const result = await runJoined(process.execPath, ["-e", "console.log('complete')"]);
    assert.equal(result.stdout.trim(), "complete");
    await assert.rejects(runJoined(process.execPath, ["-e", "process.exit(7)"]), /failed/);
    const pidFile = path.join(scratch, "child.pid");
    const program = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    await assert.rejects(
      runJoined(process.execPath, ["-e", program], { timeoutMs: 300 }),
      /timed out/,
    );
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), {
      code: "ESRCH",
    });
    await assert.rejects(
      runJoined(process.execPath, [
        "-e",
        "process.stdout.write(Buffer.alloc(5*1024*1024,32));setInterval(()=>{},1000)",
      ]),
      /aborted/,
    );
  },
);
