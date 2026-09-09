import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const phases = ["a", "b", "broad", "preferred"];
const fixture = "build-cache-topology-proof.mts";
const env = process.env;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const read = (file) => fs.readFileSync(file, "utf8");
const json = (file) => JSON.parse(read(file));
const load = (file) => import(pathToFileURL(path.resolve(file)).href);
const command = async (bin, args, options) => (await runJoined(bin, args, options)).stdout.trim();

export async function synchronize(source, target, dryRun = false, state = {}) {
  assertIdle(source);
  assertIdle(target, state);
  const roots = [source, target].map((directory) => fs.realpathSync(directory));
  assert(
    roots.every(
      (directory, index) =>
        directory !== roots[1 - index] && !directory.startsWith(`${roots[1 - index]}/`),
    ),
    "Overlapping snapshot roots",
  );
  return command("rsync", [
    "-aHc",
    "--delete",
    "--exclude=/.git/",
    "--exclude=/.ci-harness/",
    ...(dryRun ? ["--dry-run", "--itemize-changes"] : []),
    `${source}/`,
    `${target}/`,
  ]);
}

export function render(template, bindings) {
  return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/gu, (_, name) => {
    assert(Object.hasOwn(bindings, name), `Unexpected canonical key input: ${name}`);
    return bindings[name];
  });
}

function* files(root, relative = "") {
  for (const entry of fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (name === ".git" || name === ".ci-harness") continue;
    yield name;
    if (entry.isDirectory()) yield* files(root, name);
  }
}

export function inventory(root, sourceRoot = root, independent = false) {
  const digest = createHash("sha256");
  for (const name of files(root)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    digest.update(JSON.stringify([name, stat.mode]));
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(path.join(sourceRoot, name));
      assert(
        target === sourceRoot || target.startsWith(`${sourceRoot}/`),
        `Escaping dependency/link: ${name}`,
      );
      digest.update(fs.readlinkSync(file));
    } else if (stat.isFile()) {
      if (independent) {
        const other = fs.statSync(path.join(sourceRoot, name));
        assert(other.dev !== stat.dev || other.ino !== stat.ino, `Shared snapshot inode: ${name}`);
      }
      digest.update(fs.readFileSync(file));
    } else assert(stat.isDirectory(), `Unexpected snapshot entry: ${name}`);
  }
  return digest.digest("hex");
}

export function assertIdle(root, state = {}) {
  assert(!state.active, "Previous command did not complete");
  const artifacts = path.join(root, ".artifacts");
  const lock = path.join(artifacts, "dist-artifacts.lock");
  assert(!fs.existsSync(lock) || fs.readdirSync(lock).length === 0, "Unreleased build ownership");
  assert(
    !fs.existsSync(artifacts) ||
      !fs.readdirSync(artifacts).some((name) => name.startsWith("plugin-sdk-staging-")),
    "Unjoined declaration stage",
  );
}

export async function dependencies(root) {
  const require = createRequire(path.join(root, "package.json"));
  const { pnpmLockfileDocuments } = await load(
    path.join(root, "scripts/lib/pnpm-lockfile-documents.mjs"),
  );
  const lock = parse(pnpmLockfileDocuments(read(path.join(root, "pnpm-lock.yaml"))).dependencies)
    .importers["."];
  return Object.fromEntries(
    ["@openclaw/fs-safe", "typescript", "tsx", "tsdown", "yaml"].map((name) => {
      const file = fs.realpathSync(require.resolve(`${name}/package.json`));
      assert(file.startsWith(`${root}/`), `Borrowed compiler dependency: ${name}`);
      const version = json(file).version;
      const pin = (lock.dependencies?.[name] ?? lock.devDependencies?.[name]).version;
      assert(pin === version || pin.startsWith(`${version}(`), `Wrong installed version: ${name}`);
      return [name, { version, manifest: hash(read(file)) }];
    }),
  );
}

export async function runJoined(bin, args, options = {}) {
  const { runManagedCommand } = await load("scripts/lib/managed-child-process.mts");
  const controller = new AbortController();
  let log = "",
    stdout = "",
    bytes = 0;
  const started = Date.now();
  const heartbeat = setInterval(
    () => console.log(`[build-cache-proof] ${bin} ${Date.now() - started}ms`),
    30_000,
  );
  try {
    const status = await runManagedCommand({
      timeoutMs: 180_000,
      ...options,
      bin,
      args,
      requireProcessTreeExit: true,
      signal: controller.signal,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        console.log(`[build-cache-proof] ${bin} pid=${child.pid}`);
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) controller.abort(new Error("Command log exceeded 4 MiB"));
            else {
              log += chunk;
              if (stream === child.stdout) stdout += chunk;
            }
          });
      },
    });
    assert.equal(status, 0, `${bin} failed`);
    return { log, stdout, durationMs: Date.now() - started };
  } catch (error) {
    console.error(log.slice(-2000));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export function verifyGroups(log, groups, expected) {
  const observations = [
    ...log.matchAll(
      /\[(tsdown-unified|tsdown-plugin-sdk)\] (openclaw-dts-\S+): cache (hit|miss) \(([^)]+)\)/gu,
    ),
  ];
  assert.deepEqual(observations.map((match) => match[2]).sort(), [...groups].sort());
  assert(
    observations.every((match) => match[3] === expected),
    "Unexpected compiler cache outcome",
  );
  return observations.map((match) => ({ group: match[2], status: match[3], reason: match[4] }));
}

export function cgroupLimits(membership, root = "/sys/fs/cgroup", readFile = read) {
  const record = /^0::(\/.*)$/mu.exec(membership);
  assert(record, "Missing unified cgroup membership");
  const limits = [];
  let cgroup = path.resolve(root, `.${record[1]}`);
  while (true) {
    assert(cgroup === root || cgroup.startsWith(`${root}/`), "Unmapped cgroup");
    const controllers = readFile(path.join(cgroup, "cgroup.controllers")).trim();
    limits.push([
      cgroup,
      controllers,
      ...["cpu.max", "memory.max", "memory.high", "cpuset.cpus.effective"].map((name) => {
        try {
          return readFile(path.join(cgroup, name)).trim();
        } catch (error) {
          // cgroup v2 defines these limit files only for non-root groups.
          // Do not confuse unreadable files or a missing child limit with this absence.
          if (error.code === "ENOENT" && cgroup === root && name !== "cpuset.cpus.effective")
            return "absent: hierarchy-root";
          throw error;
        }
      }),
    ]);
    if (cgroup === root) return limits;
    cgroup = path.dirname(cgroup);
  }
}

export function verifyComparison(result, previous, snapshot, emit = console.log) {
  const membership = ({ receipts }) =>
    receipts.map(({ group, roots, inputs }) => ({ group, roots, inputs }));
  const comparison = {
    phase: result.phase,
    membershipMatches: digest(membership(result)) === digest(membership(previous)),
    signaturesMatch:
      digest(result.receipts.map(({ signature }) => signature)) ===
      digest(previous.receipts.map(({ signature }) => signature)),
    outputsMatch: digest(result.outputs) === digest(previous.outputs),
  };
  emit(JSON.stringify({ comparison }));
  // B deliberately changes topology; only the three A generations are byte controls.
  if (result.phase !== "b" && !comparison.outputsMatch) {
    const originals = json(snapshot);
    const expected = Object.fromEntries(previous.outputs),
      actual = Object.fromEntries(result.outputs);
    const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
      .sort()
      .filter((name) => expected[name] !== actual[name])
      .slice(0, 2);
    emit(
      JSON.stringify({
        declarationDelta: changed.map((name) => {
          const before = originals[name] ?? "",
            after = fs.existsSync(name) ? read(name) : "";
          let offset = 0;
          while (offset < Math.min(before.length, after.length) && before[offset] === after[offset])
            offset++;
          offset = Math.max(0, offset - 160);
          const excerpt = (text) =>
            text.slice(offset, offset + 512).replaceAll(process.cwd(), "<workspace>");
          return { name, offset, before: excerpt(before), after: excerpt(after) };
        }),
      }),
    );
  }
  assert(comparison.membershipMatches, "Compiler membership changed");
  if (result.phase === "b") return;
  assert(comparison.signaturesMatch, "Compiler signatures changed");
  assert(comparison.outputsMatch, "DTS bytes changed");
}

async function main() {
  const root = fs.realpathSync(process.cwd());
  const stateRoot = path.join(
    fs.realpathSync(env.RUNNER_TEMP),
    `build-cache-proof-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
  assert(!stateRoot.startsWith(`${root}/`), "Baseline must be outside source");
  const baseline = path.join(stateRoot, "baseline");
  const stateFile = path.join(stateRoot, "receipt.json");
  const phase = env.PROOF_PHASE;
  const operation = process.argv[2];
  const source = env.PROOF_SOURCE_SHA;
  assert.equal(source, "5fdf2105db2bfb2ff9569cbf953b1632b8bd6c7c");
  assert.equal(await command("git", ["rev-parse", "HEAD"]), source);
  assert.equal(
    await command("git", ["-C", ".ci-harness", "rev-parse", "HEAD"]),
    env.PROOF_WORKFLOW_SHA,
  );
  assert.equal(
    await command("git", ["-C", ".ci-harness", "diff", "--no-ext-diff", "HEAD", "--"]),
    "",
  );
  assert.equal(await command("git", ["diff", "--no-ext-diff", "HEAD", "--"]), "");
  assert.equal(process.platform, "linux");
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  for (const name of [
    "BUILD_ALL_CACHE_ROOT",
    "OPENCLAW_BUILD_CACHE",
    "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD",
    "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB",
    "OPENCLAW_BUILD_PRIVATE_QA",
  ])
    assert(!env[name], `Unexpected build override: ${name}`);
  const remaining = () => Number(env.PROOF_DEADLINE) * 1000 - Date.now();
  assert(remaining() > 60_000, "Proof deadline exhausted");
  const identity = {
    source,
    proof: env.PROOF_WORKFLOW_SHA,
    root,
    node: process.version,
    nodeHash: hash(fs.readFileSync(process.execPath)),
    lock: hash(read("pnpm-lock.yaml")),
    cpus: os.availableParallelism(),
    memory: os.totalmem(),
    boot: read("/proc/sys/kernel/random/boot_id").trim(),
    limits: cgroupLimits(read("/proc/self/cgroup")),
    dependencies: await dependencies(root),
    installedLock: hash(read("node_modules/.pnpm/lock.yaml")),
    modules: hash(read("node_modules/.modules.yaml")),
  };
  const save = (state) => fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
  assertIdle(root);
  if (operation === "init") {
    assert(!fs.existsSync(stateRoot), "Proof state already exists");
    assert(!fs.existsSync(".artifacts/build-all-cache"), "Baseline already has a build cache");
    assert(!fs.existsSync(fixture), "Fixture already exists");
    assert(!fs.existsSync("dist") && !fs.existsSync("dist-runtime"), "Baseline already built");
    const disk = fs.statfsSync(path.dirname(stateRoot));
    const kib = Number((await command("du", ["-sk", root])).split(/\s+/u)[0]);
    assert(
      disk.bavail * disk.bsize > kib * 1024 + 2 ** 30,
      "Insufficient independent-snapshot space",
    );
    fs.appendFileSync(
      await command("git", ["rev-parse", "--git-path", "info/exclude"]),
      "\n/.ci-harness/\n",
    );
    fs.mkdirSync(baseline, { recursive: true });
    await synchronize(root, baseline);
    assert.equal(await synchronize(root, baseline, true), "");
    save({ identity, baselineHash: inventory(baseline, root, true), results: [] });
    console.log(JSON.stringify({ identity, baseline }));
    return;
  }
  const state = json(stateFile);
  assert.deepEqual(identity, state.identity, "Source/runtime/resource identity changed");
  assert.equal(phases[state.results.length], phase, "Out-of-order or repeated phase");
  const action = parse(read(".github/actions/setup-node-env/action.yml"));
  const cache = action.runs.steps.find((step) => step.id === "build-all-cache").with;
  if (operation === "prepare") {
    assertIdle(root, state);
    const resetStarted = Date.now();
    assert.equal(inventory(baseline, root), state.baselineHash, "Baseline mutated");
    await synchronize(baseline, root, false, state);
    assert.equal(await synchronize(baseline, root, true), "");
    assert.equal(await command("git", ["diff", "--no-ext-diff", "HEAD", "--"]), "");
    assert(!fs.existsSync(cache.path) && !fs.existsSync(fixture));
    fs.rmSync(path.join(stateRoot, "node-compile"), { recursive: true, force: true });
    if (phase === "b") fs.writeFileSync(fixture, "export {};\n", { flag: "wx" });
    assert.equal(
      await command("git", ["ls-files", "--others", "--exclude-standard"]),
      phase === "b" ? fixture : "",
    );
    state.resetMs = Date.now() - resetStarted;
    state.started = Date.now();
    const output = path.join(stateRoot, "topology.txt");
    fs.writeFileSync(output, "");
    await command(
      "bash",
      [
        "-euo",
        "pipefail",
        "-c",
        action.runs.steps.find((step) => step.id === "build-all-topology").run,
      ],
      { env: { ...env, GITHUB_OUTPUT: output } },
    );
    const prefix = read(output)
      .trim()
      .replace(/^prefix=/u, "");
    assert.match(prefix, /^topology-[a-f0-9]{64}-$/u);
    if (phase === "a") state.topology = prefix;
    else if (phase === "b") assert.notEqual(prefix, state.topology);
    else assert.equal(prefix, state.topology, "Reset did not restore prebuild namespace");
    const bindings = {
      "github.repository": env.GITHUB_REPOSITORY,
      "inputs.build-all-cache-scope": `proof-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
      "runner.os": env.RUNNER_OS,
      "runner.arch": env.RUNNER_ARCH,
      "inputs.node-version": action.inputs["node-version"].default,
      "steps.build-all-topology.outputs.prefix": prefix,
      "github.run_id": env.GITHUB_RUN_ID,
      "github.run_attempt": env.GITHUB_RUN_ATTEMPT,
    };
    state.key =
      render(cache.key, bindings) +
      (["broad", "preferred"].includes(phase) ? `-query-${phase}` : "");
    const prefixes = render(cache["restore-keys"], bindings).trim().split("\n");
    state.restore = phase === "broad" ? prefixes.slice(1).join("\n") : prefixes.join("\n");
    state.active = phase;
    state.keyMs = Date.now() - state.started;
    save(state);
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `key=${state.key}\npath=${cache.path}\nrestore=${JSON.stringify(state.restore)}\n`,
    );
    return;
  }
  assert.equal(operation, "build");
  assert.equal(state.active, phase);
  const matched = env.PROOF_MATCHED_KEY ?? "";
  assert.equal(
    matched,
    phase === "a" ? "" : state.results[phase === "broad" ? 1 : 0].key,
    "Wrong backend generation selected",
  );
  assert.notEqual(matched, state.key, "Primary was not a guaranteed miss");
  assert(remaining() > 300_000, "Insufficient remaining proof budget");
  console.log(JSON.stringify({ phase, key: state.key, matched }));
  const { log, durationMs: buildMs } = await runJoined("pnpm", ["build"], {
    cwd: root,
    timeoutMs: Math.min(600_000, remaining() - 30_000),
    env: {
      ...env,
      NODE_OPTIONS: "--max-old-space-size=8192",
      NODE_COMPILE_CACHE: path.join(stateRoot, "node-compile"),
      NODE_COMPILE_CACHE_PORTABLE: "1",
      OPENCLAW_NODE_COMPILE_CACHE_WRITER: "0",
    },
  });
  const elapsedMs = Date.now() - state.started;
  assertIdle(root);
  assert.equal(await command("git", ["diff", "--no-ext-diff", "HEAD", "--"]), "");
  const { TSDOWN_UNIFIED_DTS_CONFIG_GROUPS: groups } = await load(
    "scripts/lib/tsdown-config-groups.mts",
  );
  const observations = verifyGroups(log, groups, phase === "preferred" ? "hit" : "miss");
  if (phase === "b" || phase === "broad")
    assert(observations.every(({ reason }) => reason === "signature-mismatch"));
  const stamps = [...files(cache.path)]
    .filter((name) => name.endsWith("/stamp.json"))
    .map((name) => ({ name, record: json(path.join(cache.path, name)) }));
  const { readDeclarationInputs } = await load("scripts/lib/tsdown-declaration-inputs.mts");
  const receipts = groups.map((group) => {
    const entry = stamps.find(({ record }) =>
      Object.hasOwn(record.outputs, `compiler-inputs/${group}.json`),
    );
    assert(entry, `Missing receipt: ${group}`);
    const receipt = json(
      path.join(cache.path, path.dirname(entry.name), "outputs/compiler-inputs", `${group}.json`),
    );
    assert.deepEqual(receipt.inputs, [...new Set(receipt.inputs)].sort());
    assert.deepEqual(
      entry.record.inputs,
      readDeclarationInputs(path.join(cache.path, path.dirname(entry.name), "outputs/dist"), group),
    );
    return { group, ...receipt, signature: entry.record.signature };
  });
  const outputs = [...files(root)]
    .filter(
      (name) =>
        /^(?:dist\/|dist-runtime\/|packages\/[^/]+\/dist\/|extensions\/[^/]+\/dist\/)/u.test(
          name,
        ) && /\.d\.(?:ts|mts|cts)$/u.test(name),
    )
    .map((name) => [name, hash(fs.readFileSync(name))]);
  assert(outputs.length > 0, "Missing DTS inventory");
  const result = {
    phase,
    key: state.key,
    matched,
    restore: state.restore,
    resetMs: state.resetMs,
    keyMs: state.keyMs,
    buildMs,
    elapsedMs,
    observations,
    receipts,
    outputs,
  };
  state.pending = result;
  save(state);
  console.log(
    JSON.stringify({
      ...result,
      outputs: { count: outputs.length, sha256: digest(outputs) },
      receipts: receipts.map(({ group, roots, inputs, signature }) => ({
        group,
        signature,
        rootsHash: digest(roots),
        inputsHash: digest(inputs),
        inputCount: inputs.length,
      })),
    }),
  );
  const snapshot = path.join(stateRoot, "a-dts.json");
  if (phase === "a") {
    const bytes = JSON.stringify(Object.fromEntries(outputs.map(([name]) => [name, read(name)])));
    assert(Buffer.byteLength(bytes) <= 64 * 1024 * 1024, "A declaration snapshot exceeds 64 MiB");
    fs.writeFileSync(snapshot, bytes, { flag: "wx" });
  } else verifyComparison(result, state.results[0], snapshot);
  delete state.pending;
  state.results.push(result);
  state.active = false;
  save(state);
  if (phase === "preferred") {
    assert.equal(inventory(baseline, root, true), state.baselineHash, "Baseline mutated");
    assert(elapsedMs < state.results[2].elapsedMs, "No net elapsed improvement");
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `Source ${source}; proof ${identity.proof}\n\n${state.results.map(({ phase, buildMs, elapsedMs, resetMs }) => `${phase}: build ${buildMs}ms; key + restore + build ${elapsedMs}ms; reset ${resetMs}ms`).join("\n\n")}\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    console.error("[build-cache-proof] FAILED (exit 1)");
    process.exitCode = 1;
  });
}
