import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { WizardSession } from "../wizard/session.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";

describe("createWizardSessionTracker", () => {
  it("keeps status and prompts on the starting socket", async () => {
    const tracker = createWizardSessionTracker();
    const session = new WizardSession(async (prompter) => {
      await prompter.note("Sign in");
    });
    tracker.trackWizardSession(session, "owner", "login");

    expect(tracker.findOwnedWizardSession("login", "other")).toBeUndefined();
    expect(tracker.findOwnedWizardSession("login", undefined)).toBeUndefined();
    expect(tracker.findOwnedWizardSession("login", "owner")).toBe(session);
    session.cancel();
    await session.whenSettled();
  });

  it("does not replace a retained wizard with a duplicate id", async () => {
    const tracker = createWizardSessionTracker();
    const first = new WizardSession(async (prompter) => {
      await prompter.note("First");
    });
    const second = new WizardSession(async (prompter) => {
      await prompter.note("Second");
    });
    expect(tracker.trackWizardSession(first, "owner", "login")).toBe("login");
    expect(tracker.trackWizardSession(second, "other", "login")).toBeNull();
    expect(tracker.findOwnedWizardSession("login", "owner")).toBe(first);
    first.cancel();
    second.cancel();
    await Promise.all([first.whenSettled(), second.whenSettled()]);
  });

  it("cancels only the disconnected socket and retains its session until settlement", async () => {
    const tracker = createWizardSessionTracker();
    const release = createDeferred();
    const first = new WizardSession(async () => {
      await release.promise;
    });
    const other = new WizardSession(async (prompter) => {
      await prompter.note("Other");
    });
    tracker.trackWizardSession(first, "owner", "first");
    tracker.trackWizardSession(other, "other", "other");
    tracker.handleWizardDisconnect("owner");

    expect(first.getStatus()).toBe("cancelled");
    expect(other.getStatus()).toBe("running");
    expect(tracker.findRunningWizard()).toBe("first");
    release.resolve();
    await first.whenSettled();
    expect(tracker.findOwnedWizardSession("first", "owner")).toBeUndefined();
    other.cancel();
    await other.whenSettled();
  });

  it("ends input after disconnect during protected preparation without interrupting its write", async () => {
    const tracker = createWizardSessionTracker();
    const release = createDeferred();
    let continued = false;
    const session = new WizardSession(async (_prompter, _signal, running) => {
      running.lockCancellationForPreparation();
      await release.promise;
      running.finishPreparation();
      continued = true;
    });
    tracker.trackWizardSession(session, "owner", "prepare");
    tracker.handleWizardDisconnect("owner");
    expect(session.signal.aborted).toBe(false);
    expect(tracker.findRunningWizard()).toBe("prepare");
    release.resolve();
    await session.whenSettled();
    expect(continued).toBe(false);
    expect(session.getStatus()).toBe("error");
    expect(tracker.findOwnedWizardSession("prepare", "owner")).toBeUndefined();
  });

  it("lets an already committed effect finish after disconnect", async () => {
    const tracker = createWizardSessionTracker();
    const release = createDeferred();
    let finished = false;
    const session = new WizardSession(async (_prompter, _signal, running) => {
      running.lockCancellation();
      await release.promise;
      finished = true;
    });
    tracker.trackWizardSession(session, "owner", "committed");
    tracker.handleWizardDisconnect("owner");
    expect(session.signal.aborted).toBe(false);
    expect(tracker.findRunningWizard()).toBe("committed");
    release.resolve();
    await session.whenSettled();
    expect(finished).toBe(true);
    expect(session.getStatus()).toBe("done");
  });

  it("retains an uncollected terminal result before reaping it", async () => {
    let now = 1_000;
    const tracker = createWizardSessionTracker({ now: () => now });
    const terminal = new WizardSession(async () => {});
    tracker.trackWizardSession(terminal, undefined, "finished");
    await terminal.next();

    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(true);

    now += 5 * 60 * 1000 - 1;
    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(true);

    now += 1;
    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(false);
  });

  it("retains and reports the running session", () => {
    const tracker = createWizardSessionTracker();
    const running = new WizardSession(async (prompter) => {
      await prompter.note("waiting");
    });
    tracker.trackWizardSession(running, undefined, "running");

    expect(tracker.findRunningWizard()).toBe("running");
    expect(tracker.findOwnedWizardSession("running", undefined)).toBe(running);
    running.cancel();
  });

  it("keeps a cancelled session active until its runner settles", async () => {
    const tracker = createWizardSessionTracker();
    const releaseRunner = createDeferred();
    const cancelled = new WizardSession(async () => {
      await releaseRunner.promise;
    });
    tracker.trackWizardSession(cancelled, undefined, "cancelled");

    expect(cancelled.cancel()).toBe(true);
    tracker.purgeWizardSession("cancelled");
    expect(tracker.findRunningWizard()).toBe("cancelled");
    expect(tracker.wizardSessions.has("cancelled")).toBe(true);

    releaseRunner.resolve();
    await expect.poll(() => cancelled.isSettled()).toBe(true);
    expect(tracker.findRunningWizard()).toBeNull();
    tracker.purgeWizardSession("cancelled");
    expect(tracker.wizardSessions.has("cancelled")).toBe(false);
  });
});
