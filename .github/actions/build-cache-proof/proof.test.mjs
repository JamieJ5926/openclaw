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
  oldA,
  phaseKeys,
  render,
  runJoined,
  synchronize,
  verifyComparison,
  verifyGroups,
  verifyOldA,
  verifyOldAIdentity,
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

test("resumed A requires its exact cache, runtime, inventory, and membership receipt", () => {
  const identity = {
    source: oldA.source,
    node: "v24.19.0",
    dependencies: Object.fromEntries(
      [
        ["@openclaw/fs-safe", "0.8.5"],
        ["typescript", "6.0.3"],
        ["tsdown", "0.22.14"],
      ].map(([name, version]) => [name, { version }]),
    ),
  };
  verifyOldAIdentity(identity);
  for (const field of ["source", "node"])
    assert.throws(() => verifyOldAIdentity({ ...identity, [field]: "changed" }));
  const changed = structuredClone(identity);
  changed.dependencies.typescript.version = "6.0.4";
  assert.throws(() => verifyOldAIdentity(changed), /dependencies changed/);
  const result = {
    key: oldA.key,
    matched: oldA.key,
    outputs: { count: 693, sha256: oldA.outputs },
    receipts: oldA.receipts,
  };
  verifyOldA(result, true);
  for (const matched of [undefined, "", `${oldA.key}-other`])
    assert.throws(() => verifyOldA({ matched }), /Exact recorded A cache match/);
  for (const outputs of [
    { count: 692, sha256: oldA.outputs },
    { count: 693, sha256: "changed" },
  ])
    assert.throws(() => verifyOldA({ ...result, outputs }, true), /inventory changed/);
  assert.throws(
    () => verifyOldA({ ...result, receipts: "changed" }, true),
    /membership\/signatures changed/,
  );
});

test("B may change declaration bytes, but every phase preserves membership and every A preserves bytes", () => {
  const root = directory("comparison");
  const file = path.join(root, "entry.d.ts"),
    snapshot = path.join(root, "a-dts.json");
  const previous = {
    outputs: [[file, "a-hash"]],
    receipts: [
      { group: "group", roots: ["src/entry.ts"], inputs: ["src/entry.ts"], signature: "a" },
    ],
  };
  fs.writeFileSync(snapshot, JSON.stringify({ [file]: "export type Value = 'before';\n" }));
  fs.writeFileSync(file, "export type Value = 'after';\n");
  const logs = [],
    emit = (value) => logs.push(JSON.parse(value));
  const b = structuredClone({ ...previous, phase: "b" });
  b.outputs[0][1] = "b-hash";
  b.receipts[0].signature = "b";
  verifyComparison(b, previous, snapshot, emit);
  assert.deepEqual(logs.pop().comparison, {
    phase: "b",
    membershipMatches: true,
    signaturesMatch: false,
    outputsMatch: false,
  });
  for (const phase of ["b", "broad", "preferred"])
    for (const field of ["roots", "inputs"]) {
      const changed = structuredClone({ ...previous, phase });
      changed.receipts[0][field].push("src/unexpected.ts");
      assert.throws(
        () => verifyComparison(changed, previous, snapshot, emit),
        /membership changed/,
      );
      assert.equal(logs.pop().comparison.membershipMatches, false);
    }
  for (const phase of ["broad", "preferred"]) {
    verifyComparison({ ...previous, phase }, previous, snapshot, emit);
    const changed = structuredClone({ ...previous, phase });
    changed.receipts[0].signature = "changed";
    assert.throws(() => verifyComparison(changed, previous, snapshot, emit), /signatures changed/);
    for (const outputs of [[[file, "changed"]], [[`${file}.renamed`, "a-hash"]]]) {
      logs.length = 0;
      assert.throws(
        () => verifyComparison({ ...previous, phase, outputs }, previous, snapshot, emit),
        /DTS bytes changed/,
      );
      assert.equal(logs[0].comparison.outputsMatch, false);
      assert(logs[1].declarationDelta.length <= 2);
      assert(logs[1].declarationDelta.some(({ before }) => before.includes("'before'")));
      assert(
        logs[1].declarationDelta.every(
          ({ before, after }) => before.length <= 512 && after.length <= 512,
        ),
      );
    }
  }
});

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

test("four bounded phases restore exact old A, use the old task scope, and publish only new B", () => {
  const bindings = {
    "github.repository": "openclaw/openclaw",
    "inputs.build-all-cache-scope": oldA.scope,
    "runner.os": "Linux",
    "runner.arch": "X64",
    "inputs.node-version": "24.x",
    "github.run_id": "123",
    "github.run_attempt": "1",
  };
  const selectPhase = (phase) =>
    phaseKeys(phase, cache, {
      ...bindings,
      "steps.build-all-topology.outputs.prefix": phase === "b" ? "topology-b-" : oldA.topology,
    });
  const keys = [selectPhase("a").key, selectPhase("b").key];
  assert.equal(keys[0], oldA.key);
  assert.equal(selectPhase("a").restore, "");
  assert(keys[1].startsWith(`openclaw/openclaw-build-all-v1-${oldA.scope}-`));
  assert(keys[1].endsWith("-123-1"));
  assert.throws(
    () =>
      phaseKeys("a", cache, { ...bindings, "steps.build-all-topology.outputs.prefix": "changed" }),
    /topology changed/,
  );
  const prefixes = selectPhase("preferred").restore.split("\n");
  const newest = [...keys].reverse();
  const select = (values, available = newest) =>
    values.flatMap((prefix) => available.filter((key) => key.startsWith(prefix)))[0];
  assert.equal(select(prefixes.slice(1)), keys[1]);
  assert.equal(select(prefixes), keys[0]);
  for (const phase of ["broad", "preferred"]) {
    assert(!newest.some((key) => key.startsWith(selectPhase(phase).key)));
    assert(selectPhase(phase).key.endsWith(`-123-1-query-${phase}`));
  }
  assert.equal(selectPhase("broad").restore, prefixes[1]);
  assert.equal(select(selectPhase("b").restore.split("\n"), [oldA.key]), oldA.key);
  assert.throws(() => render("${{ unsupported }}", bindings), /Unexpected canonical/);
  const phases = workflow.jobs["topology-proof"].steps.filter(
    (step) => step.uses === "./.ci-harness/.github/actions/build-cache-proof",
  );
  assert.deepEqual(
    phases.map((step) => step.with.phase),
    ["a", "b", "broad", "preferred"],
  );
  assert.deepEqual(
    phases.map((step) => step["timeout-minutes"]),
    [6, 8, 8, 6],
  );
  const saves = phaseAction.runs.steps.filter((step) =>
    step.uses?.startsWith("actions/cache/save@"),
  );
  assert.equal(saves.length, 1);
  assert.deepEqual(
    phases
      .filter((step) => evaluate(saves[0].if, { inputs: step.with }))
      .map((step) => step.with.phase),
    ["b"],
  );
  assert.equal(
    phaseAction.runs.steps.find((step) => step.id === "restore").uses,
    "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  );
  assert.equal(phaseAction.runs.steps.find((step) => step.id === "restore").if, undefined);
  assert.equal(
    phaseAction.runs.steps.find((step) => step.id === "restore").with["fail-on-cache-miss"],
    true,
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
    "node-version": "24.19.0",
    "cache-mode": "restore",
    "dependency-cache": "true",
    "install-bun": "false",
  });
});

test(
  "an observed resumed-A miss aborts and joins the compiler process group",
  { timeout: 20_000 },
  async () => {
    const file = path.join(scratch, "miss-pids.json");
    const program = `const fs=require("node:fs"),{spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,child.pid]));process.stderr.write("[tsdown-unified] openclaw-dts-base: cache mi");setTimeout(()=>process.stderr.write("ss (signature-mismatch)\\n"),20);setInterval(()=>{},1000);`;
    await assert.rejects(
      runJoined(process.execPath, ["-e", program], { cacheHitsOnly: true, timeoutMs: 5000 }),
      /aborted/,
    );
    for (const pid of JSON.parse(fs.readFileSync(file, "utf8")))
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

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
