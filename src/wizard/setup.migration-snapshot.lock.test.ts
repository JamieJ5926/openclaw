import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  preserveSetupMigrationOnboardingConsents,
  withSetupMigrationTargetLock,
} from "./setup.migration-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("setup migration target lock", () => {
  it("preserves a persisted UTC-offset revocation when replaying pre-lock feature consent", async () => {
    const stateDir = tempDirs.make("openclaw-setup-consent-");
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        HOME: stateDir,
        USERPROFILE: stateDir,
      },
      async () => {
        const {
          mutateConfigFileWithRetry,
          readConfigFileSnapshot,
          transformConfigFileWithRetry,
          writeConfigFile,
        } = await import("../config/config.js");
        const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
        try {
          await writeConfigFile({
            telemetry: {
              runtimeUtcOffsetEnabled: true,
              runtimeUtcOffsetConsentedAt: "2026-09-01T12:00:00.000Z",
            },
          });
          const staleSnapshot = await readConfigFileSnapshot();
          expect(staleSnapshot.valid).toBe(true);
          const consentedAt = "2026-09-09T12:00:00.000Z";
          const inMemoryConfig = {
            ...staleSnapshot.config,
            wizard: { securityAcknowledgedAt: consentedAt },
            telemetry: { ...staleSnapshot.config.telemetry, enabled: true, consentedAt },
          };
          await mutateConfigFileWithRetry({
            mutate: (draft) => {
              draft.telemetry = { ...draft.telemetry, runtimeUtcOffsetEnabled: false };
              delete draft.telemetry.runtimeUtcOffsetConsentedAt;
            },
          });

          await withSetupMigrationTargetLock(stateDir, async () => {
            await transformConfigFileWithRetry({
              transform: (config) => ({
                nextConfig: preserveSetupMigrationOnboardingConsents(config, inMemoryConfig),
              }),
            });
          });

          const persisted = await readConfigFileSnapshot();
          expect(persisted.valid).toBe(true);
          expect(persisted.config.telemetry).toEqual({
            enabled: true,
            consentedAt,
            runtimeUtcOffsetEnabled: false,
          });
          expect(persisted.config.wizard?.securityAcknowledgedAt).toBe(consentedAt);
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  });

  it("rejects a concurrent profile operation with the active holder", async () => {
    await withEnvAsync({ OPENCLAW_PROFILE: "lock-test" }, async () => {
      const stateDir = tempDirs.make("openclaw-setup-target-lock-");
      const firstAcquired = createDeferred();
      const releaseFirst = createDeferred();
      const first = withSetupMigrationTargetLock(stateDir, async () => {
        firstAcquired.resolve();
        await releaseFirst.promise;
      });
      await firstAcquired.promise;

      let secondRan = false;
      const second = withSetupMigrationTargetLock(stateDir, async () => {
        secondRan = true;
      });
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        second.then(
          () => ({ kind: "acquired" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "waiting" }>((resolve) => {
          waitTimer = setTimeout(() => resolve({ kind: "waiting" }), 1_000);
        }),
      ]);
      clearTimeout(waitTimer);

      releaseFirst.resolve();
      await first;
      if (outcome.kind === "waiting") {
        await second;
      }

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") {
        return;
      }
      expect(outcome.error).toMatchObject({
        name: "SetupTargetLockedError",
        code: "setup_target_locked",
        holderPid: process.pid,
      });
      expect((outcome.error as Error).message).toBe(
        `Another onboarding/config operation is running for profile lock-test (pid ${process.pid}). Finish or abort it, then re-run.`,
      );
      expect(secondRan).toBe(false);

      await expect(withSetupMigrationTargetLock(stateDir, async () => "ok")).resolves.toBe("ok");
    });
  });
});
