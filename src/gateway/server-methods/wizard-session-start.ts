import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { WizardSession } from "../../wizard/session.js";
import { createAdmittedWizardSession, respondSetupAdmissionBusy } from "./setup-admission.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

/** Register the starting socket before acknowledging a remote wizard. */
export async function startGatewayWizardSession(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  sessionId: string;
  ownerConnId?: string;
  timeoutMs: number;
  run: ConstructorParameters<typeof WizardSession>[0];
}): Promise<WizardSession | null> {
  if (params.context.wizardSessions.has(params.sessionId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard session already exists"),
    );
    return null;
  }
  const session = await createAdmittedWizardSession(
    () => new WizardSession(params.run, { timeoutMs: params.timeoutMs }),
  );
  if (!session) {
    respondSetupAdmissionBusy(params.respond);
    return null;
  }
  if (!params.context.trackWizardSession(session, params.ownerConnId, params.sessionId)) {
    session.cancel();
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard session already exists"),
    );
    return null;
  }
  params.respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
  return session;
}
