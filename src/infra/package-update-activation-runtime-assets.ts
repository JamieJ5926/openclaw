import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

export const PACKAGE_ACTIVATION_HELPER = "recovery.mjs";
export const packageActivationRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "package-update-activation-sealed",
  distWorkerPath: "package-update-activation-recovery.mjs",
};

export function stagePackageActivationRuntime(anchor: string, assertCurrent: () => void): string {
  const source = resolveRuntimeWorkerUrl(packageActivationRuntimeEntrypoint);
  if (!source.pathname.endsWith(".mjs")) {
    throw new Error("Package publication recovery requires its built sealed helper.");
  }
  const bytes = fs.readFileSync(source);
  assertCurrent();
  fs.writeFileSync(path.join(anchor, PACKAGE_ACTIVATION_HELPER), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return createHash("sha256").update(bytes).digest("hex");
}
