import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads the worker compiler with native Node before preparing artifacts", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
await import("./scripts/lib/vitest-worker-compiler.mts");
console.log("native worker compiler import verified");
`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );

  expect(output.trim()).toBe("native worker compiler import verified");
});

it("seals recovery runtimes in independent single-entry builds", () => {
  // Separate tsx config loading avoids Vitest requesting artifacts before shape validation.
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import configs from "./tsdown.config.ts";
for (const name of ["managed-handoff-runtime", "package-update-activation-recovery"]) {
  const config = configs.find(config =>
    config.entry && typeof config.entry === "object" && name in config.entry
  );
  assert.ok(config, name + ": missing recovery build");
  assert.deepEqual(Object.keys(config.entry), [name], name + ": sealed build must have one entry");
  assert.equal(config.outputOptions.codeSplitting, false);
  assert.equal(config.define.SEALED_RUNTIME_BUILD, "true");
  assert.equal(config.outDir, "dist");
  assert.equal(config.dts, false);
  assert.equal(config.shims, true);
  assert.equal(config.deps.onlyBundle, false);
  assert.equal(config.deps.alwaysBundle("json5", undefined), true);
  assert.equal(config.deps.alwaysBundle("node:fs", undefined), false);
  assert.equal(config.outExtensions({ format: "es", options: {}, pkgType: "module" }).js, ".mjs");
}
console.log("sealed recovery configs verified");
`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );

  expect(output.trim()).toBe("sealed recovery configs verified");
});
