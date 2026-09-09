import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { ProviderAuthChoiceMetadata } from "../../plugins/provider-auth-choices.js";
import type { WizardSession } from "../../wizard/session.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { modelsAuthLoginHandlers } from "./models-auth-login.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  choice: vi.fn<() => ProviderAuthChoiceMetadata | undefined>(),
  login: vi.fn<(options: ModelsAuthLoginFlowOptions) => Promise<void>>(),
}));
vi.mock("../../commands/models/auth.js", () => ({ runModelsAuthLoginFlowCore: mocks.login }));
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeclaredProviderAuthChoice: mocks.choice,
}));
// Target-lock admission and release are covered by the shared wizard suite.
vi.mock("./setup-admission.js", () => ({
  createAdmittedWizardSession: async (create: () => WizardSession) => create(),
  whenAdmittedWizardSessionSettled: (session: WizardSession) => session.whenSettled(),
}));

const choice: ProviderAuthChoiceMetadata = {
  pluginId: "login-owner",
  providerId: "fixture",
  methodId: "secret",
  choiceId: "fixture-secret",
  choiceLabel: "Fixture",
  appGuidedSecret: true,
};
const trackers: Array<ReturnType<typeof createWizardSessionTracker>> = [];
function createRequest() {
  const tracker = createWizardSessionTracker();
  trackers.push(tracker);
  const respond = vi.fn();
  const authority = vi.fn(() => true);
  const params = { sessionId: "login", agentId: "main", authChoice: choice.choiceId };
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "request", method: "models.authLogin", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: createDirectChatContext({ ...tracker, getRuntimeConfig: () => ({}) }),
    hasCurrentClientAuthority: authority,
  };
  return { tracker, respond, options, authority };
}

beforeEach(() => {
  mocks.choice.mockReset().mockReturnValue(choice);
  mocks.login.mockReset().mockImplementation(async ({ prompter, beforePersistentEffect }) => {
    await prompter.note("Sign in");
    beforePersistentEffect?.();
  });
});
afterEach(async () => {
  for (const tracker of trackers.splice(0)) {
    for (const { session } of tracker.wizardSessions.values()) {
      session.cancel();
      await session.whenSettled();
    }
  }
});

describe("models.authLogin", () => {
  it("acknowledges the registered session before waiting for its first prompt", async () => {
    const { tracker, respond, options } = createRequest();
    await modelsAuthLoginHandlers["models.authLogin"]!(options);
    expect(respond).toHaveBeenCalledWith(
      true,
      { sessionId: "login", done: false, status: "running" },
      undefined,
    );
    const session = tracker.findOwnedWizardSession("login", undefined)!;
    expect((await session.next()).step?.message).toBe("Sign in");
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPluginId: "login-owner",
        provider: "fixture",
        method: "secret",
        credentialOnly: true,
        agent: "main",
        isRemote: true,
      }),
    );
  });

  it("refuses a missing manifest choice before admitting or invoking login", async () => {
    mocks.choice.mockReturnValue(undefined);
    const { tracker, respond, options } = createRequest();
    await modelsAuthLoginHandlers["models.authLogin"]!(options);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(tracker.wizardSessions.size).toBe(0);
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it.each(["removed-choice", "changed-method", "retired-connection"] as const)(
    "refuses persistence after %s while the prompt was open",
    async (change) => {
      let persisted = false;
      mocks.login.mockImplementation(async ({ prompter, beforePersistentEffect }) => {
        await prompter.note("Sign in");
        beforePersistentEffect?.();
        persisted = true;
      });
      const { tracker, options, authority } = createRequest();
      await modelsAuthLoginHandlers["models.authLogin"]!(options);
      const session = tracker.findOwnedWizardSession("login", undefined)!;
      const step = (await session.next()).step!;
      if (change === "removed-choice") mocks.choice.mockReturnValue(undefined);
      if (change === "changed-method")
        mocks.choice.mockReturnValue({ ...choice, methodId: "other" });
      if (change === "retired-connection") authority.mockReturnValue(false);
      await session.answer(step.id, undefined);
      await session.whenSettled();
      expect(persisted).toBe(false);
      expect(session.getStatus()).toBe("error");
    },
  );
});
