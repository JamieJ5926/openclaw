import {
  ErrorCodes,
  errorShape,
  validateModelsAuthLoginParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runModelsAuthLoginFlowCore } from "../../commands/models/auth.js";
import { resolveManifestDeclaredProviderAuthChoice } from "../../plugins/provider-auth-choices.js";
import { isProviderLoginChoiceStartable } from "../../plugins/provider-login-options.js";
import { defaultRuntime } from "../../runtime.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { startGatewayWizardSession } from "./wizard-session-start.js";

const LOGIN_TIMEOUT_MS = 25 * 60 * 1000;
const UNAVAILABLE_LOGIN =
  "That sign-in option is unavailable. Refresh Models and choose an available option.";

export const modelsAuthLoginHandlers: GatewayRequestHandlers = {
  "models.authLogin": async ({
    params,
    context,
    respond,
    client,
    signal: requestSignal,
    hasCurrentClientAuthority,
  }) => {
    if (!assertValidParams(params, validateModelsAuthLoginParams, "models.authLogin", respond)) {
      return;
    }
    const config = context.getRuntimeConfig();
    const choice = resolveManifestDeclaredProviderAuthChoice(params.authChoice, {
      config,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    });
    if (!choice || !isProviderLoginChoiceStartable(choice)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, UNAVAILABLE_LOGIN));
      return;
    }
    const session = await startGatewayWizardSession({
      context,
      respond,
      sessionId: params.sessionId,
      ownerConnId: client?.connId,
      timeoutMs: LOGIN_TIMEOUT_MS,
      run: async (prompter, signal, running) => {
        const assertCurrent = () => {
          requestSignal?.throwIfAborted();
          signal.throwIfAborted();
          if (hasCurrentClientAuthority && !hasCurrentClientAuthority()) {
            throw new Error("Connection authority changed before sign-in completed.");
          }
        };
        assertCurrent();
        const warnings: string[] = [];
        await runModelsAuthLoginFlowCore({
          provider: choice.providerId,
          method: choice.methodId,
          ownerPluginId: choice.pluginId,
          credentialOnly: true,
          agent: params.agentId,
          config,
          prompter,
          signal,
          isRemote: true,
          runtime: {
            ...defaultRuntime,
            log: (message) => running.pushProgress(String(message)),
            error: (message) => {
              warnings.push(String(message));
              running.pushProgress(String(message));
            },
            exit: (code): never => {
              throw new Error(`Sign-in step exited with code ${String(code)}`);
            },
          },
          openUrl: async (url) => {
            assertCurrent();
            running.queueExternalUrl(url);
            running.pushProgress("Continue sign-in in your browser.");
          },
          beforePersistentEffect: () => {
            assertCurrent();
            const current = resolveManifestDeclaredProviderAuthChoice(params.authChoice, {
              config: context.getRuntimeConfig(),
              includeUntrustedWorkspacePlugins: false,
              includeWorkspacePlugins: false,
            });
            if (
              !current ||
              !isProviderLoginChoiceStartable(current) ||
              current.pluginId !== choice.pluginId ||
              current.providerId !== choice.providerId ||
              current.methodId !== choice.methodId ||
              context.findOwnedWizardSession(params.sessionId, client?.connId) !== running
            ) {
              throw new Error(UNAVAILABLE_LOGIN);
            }
            running.lockCancellation();
          },
        });
        if (warnings.length > 0) {
          throw new Error(
            `Sign-in saved credentials, but a follow-up needs attention.\n${warnings.join("\n")}`,
          );
        }
      },
    });
    if (session && requestSignal) {
      const cancel = () => session.cancel();
      requestSignal.addEventListener("abort", cancel, { once: true });
      if (requestSignal.aborted) {
        cancel();
      }
      const release = () => requestSignal.removeEventListener("abort", cancel);
      void whenAdmittedWizardSessionSettled(session).then(release, release);
    }
  },
};
