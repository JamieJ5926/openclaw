import { defaultRuntime } from "../../runtime.js";
import { activateGatewaySetupInference } from "./system-agent-execution.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { startGatewayWizardSession } from "./wizard-session-start.js";

export async function startSetupActivationWizard(params: {
  sessionId: string;
  activation: Pick<
    Parameters<typeof activateGatewaySetupInference>[0],
    | "kind"
    | "agentId"
    | "modelRef"
    | "authChoice"
    | "apiKey"
    | "workspace"
    | "nativeSessionCatalogsEnabled"
  >;
  isLocalClient?: boolean;
  ownerConnId?: string;
  timeoutMs: number;
  context: GatewayRequestContext;
  respond: RespondFn;
}) {
  await startGatewayWizardSession({
    context: params.context,
    respond: params.respond,
    sessionId: params.sessionId,
    ownerConnId: params.ownerConnId,
    timeoutMs: params.timeoutMs,
    run: async (prompter, signal, runnerSession) => {
      const result = await activateGatewaySetupInference({
        ...params.activation,
        surface: "gateway",
        isRemoteProviderAuth: params.isLocalClient !== true,
        runtime: {
          ...defaultRuntime,
          exit: (code: number | undefined): never => {
            throw new Error(`setup step exited with code ${String(code)}`);
          },
        },
        prompter,
        signal,
        isCancelled: () => signal.aborted,
        beforePersistentEffect: () => runnerSession.lockCancellationForPreparation(),
        onPreparationComplete: () => runnerSession.finishPreparation(),
        onCommitStarted: () => runnerSession.lockCancellation(),
      });
      signal.throwIfAborted();
      if (!result.ok) {
        if (result.disposition === "rejected-before-promotion") {
          runnerSession.setActivationRejection({
            disposition: result.disposition,
            status: result.status,
          });
        }
        throw new Error(result.error);
      }
      runnerSession.setModelActivation({
        modelRef: result.modelRef,
        ...(result.gatewayRestartRequired ? { gatewayRestartRequired: true } : {}),
      });
    },
  });
}
