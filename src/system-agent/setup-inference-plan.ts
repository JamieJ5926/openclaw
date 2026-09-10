import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
import { CliExecutionAuthProfileError } from "../agents/cli-execution-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { PreparedModelSelectionContext } from "../agents/prepared-model-selection.js";
import { withPreparedSimpleCompletionSelection } from "../agents/simple-completion-runtime.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
} from "../commands/onboard-inference.js";
import { createMergePatch } from "../config/merge-patch.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginInConfig, enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  prepareAuthChoiceLoadedPluginProvider,
  runProviderPluginAuthMethodUnpersisted,
} from "../plugins/provider-auth-choice.js";
import {
  resolveManifestProviderAuthChoice,
  type ProviderAuthChoiceMetadata,
} from "../plugins/provider-auth-choices.js";
import { resolveProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import {
  type ActivateSetupInferenceResult,
  SetupInferenceCancelledError,
  type SetupInferenceFailureStatus,
  parseProviderAutoSetupChoiceId,
  throwIfSetupInferenceCancelled,
  waitForProviderAuth,
} from "./setup-inference-core.js";
import { cleanupSetupInferenceTempDir } from "./setup-inference-persist.js";
import {
  type SetupInferencePlanBuildParams,
  type SetupInferenceTestPlan,
  buildPreparedProviderTestPlan,
  canonicalizeSetupModelRef,
  parseRef,
  prepareManualAuthForActivation,
} from "./setup-inference-plan-helpers.js";
import { runProviderManualSecretMethod } from "./setup-inference-plan-provider-auth.js";

async function prepareSetupProviderAuthChoice(
  params: SetupInferencePlanBuildParams,
  choice: ProviderAuthChoiceMetadata,
) {
  // Carry callable auth methods past the lease, never an unbound enabled config.
  return await withPluginLifecycleLease({ signal: params.signal }, async () => {
    const enablePlugin = params.deps.enablePluginInConfig ?? enablePluginInConfig;
    const enableResult = await enablePluginWithCapabilityConsent(params.cfg, choice.pluginId, {
      workspaceDir: params.pluginWorkspaceDir,
      beforePersistentEffect: params.beforePersistentEffect,
      onCapabilityConsent: params.prompter
        ? createPluginCapabilityConsentPrompter(params.prompter, () =>
            throwIfSetupInferenceCancelled(params),
          )
        : undefined,
    });
    if (!enableResult.enabled) {
      return { error: `${choice.choiceLabel} is disabled (${enableResult.reason ?? "blocked"}).` };
    }
    const sourceEnableResult = enablePlugin(params.sourceCfg, choice.pluginId);
    if (!sourceEnableResult.enabled) {
      return {
        error: `${choice.choiceLabel} is disabled (${sourceEnableResult.reason ?? "blocked"}).`,
      };
    }
    const providers = (params.deps.resolvePluginProviders ?? resolvePluginProvidersCore)({
      config: enableResult.config,
      workspaceDir: params.pluginWorkspaceDir,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
      onlyPluginIds: [choice.pluginId],
    });
    const provider = providers.find(
      (candidate) =>
        candidate.pluginId === choice.pluginId &&
        normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
    );
    const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
    return { enableResult, provider, method };
  });
}

type SetupInferencePlanResult =
  | SetupInferenceTestPlan
  | { error: string; status?: SetupInferenceFailureStatus };

export type SetupInferencePlanScope = {
  tempDir: string;
  testAgentDir: string;
  selection?: PreparedModelSelectionContext;
};

/** Keep selected facts and temporary resources alive through their consuming operation. */
export async function withSetupInferencePlan<T>(
  params: Omit<
    SetupInferencePlanBuildParams,
    "workspaceDir" | "agentDir" | "pluginWorkspaceDir"
  > & {
    pluginWorkspaceDir?: string;
  },
  run: (plan: SetupInferenceTestPlan, scope: SetupInferencePlanScope) => Promise<T>,
): Promise<T | Extract<ActivateSetupInferenceResult, { ok: false }>> {
  return await runWithAsyncWorkResources(async (onAcquired) => {
    const tempDir = await (
      params.deps.createTempDir ??
      (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
    )();
    onAcquired({
      release: () =>
        cleanupSetupInferenceTempDir({ tempDir, deps: params.deps, runtime: params.runtime }),
    });
    const testAgentDir = path.join(tempDir, "agent");
    const prepared = {
      ...params,
      routeAgentId: resolveAmbientOwnerAgentId(params.cfg, params.routeAgentId),
      workspaceDir: tempDir,
      pluginWorkspaceDir: params.pluginWorkspaceDir ?? tempDir,
      agentDir: testAgentDir,
    };
    const consumePlan = async (
      plan: SetupInferencePlanResult,
      selection?: PreparedModelSelectionContext,
    ): Promise<T | Extract<ActivateSetupInferenceResult, { ok: false }>> =>
      "error" in plan
        ? { ok: false, status: plan.status ?? "unavailable", error: plan.error }
        : await run(plan, { tempDir, testAgentDir, selection });
    if (params.kind !== "existing-model") {
      return await consumePlan(await buildProviderSetupInferencePlan(prepared));
    }
    return await withPreparedSimpleCompletionSelection(
      {
        cfg: params.cfg,
        agentId: prepared.routeAgentId,
        readOnly: true,
        abortSignal: params.signal,
      },
      async (_selection, selection) =>
        await consumePlan(await buildExistingSetupInferencePlan(prepared, selection), selection),
    );
  });
}

async function buildExistingSetupInferencePlan(
  params: SetupInferencePlanBuildParams,
  context: PreparedModelSelectionContext,
): Promise<SetupInferencePlanResult> {
  const cfg = context.preparedModelRuntime.config;
  const { metadataSnapshot, modelCatalog } = context.preparedModelRuntime;
  let route;
  try {
    route = await resolveSystemAgentConfiguredRouteFromConfig(
      cfg,
      params.routeAgentId,
      {
        loadAuthProfileStoreForRuntime: params.deps.loadAuthProfileStoreForRuntime,
        pluginMetadataPlugins: metadataSnapshot.plugins,
        resolvedModelCatalog: modelCatalog.entries,
      },
      params.configSnapshot,
    );
  } catch (error) {
    if (error instanceof CliExecutionAuthProfileError) {
      return { error: error.message, status: "auth" as const };
    }
    throw error;
  }
  if (!route) {
    return { error: "No configured default-agent inference route is available." };
  }
  const requestedModelRef = params.modelRef?.trim();
  const requestedTarget = requestedModelRef
    ? canonicalizeSetupModelRef({
        cfg,
        raw: requestedModelRef,
        defaultProvider: route.provider,
        agentId: route.agentId,
        manifestPlugins: metadataSnapshot,
        resolvedModelCatalog: modelCatalog.entries,
      })
    : undefined;
  if (requestedModelRef && requestedTarget !== route.modelLabel) {
    return {
      error: `The configured default model changed from ${requestedModelRef} to ${route.modelLabel}. Try setup again.`,
    };
  }
  const { runConfig, sourceConfig: _sourceConfig, modelLabel, agentId, ...selection } = route;
  return {
    ...selection,
    modelRef: modelLabel,
    requestedRouteResolution: "resolved",
    config: cfg,
    executionConfig: runConfig,
    agentId: "openclaw",
    routeAgentId: agentId,
  };
}

async function buildProviderSetupInferencePlan(
  params: SetupInferencePlanBuildParams,
): Promise<SetupInferencePlanResult> {
  const { kind, cfg, workspaceDir } = params;
  const routeAgentId = resolveAmbientOwnerAgentId(cfg, params.routeAgentId);
  const resolveRouteModelRef = (defaultModelRef: string): string | { error: string } => {
    const modelRef = params.modelRef?.trim() || defaultModelRef;
    const selected = parseRef(modelRef);
    const expected = parseRef(defaultModelRef);
    if (
      !selected.model ||
      normalizeProviderId(selected.provider) !== normalizeProviderId(expected.provider)
    ) {
      return { error: `${modelRef} is not compatible with the ${kind} inference route.` };
    }
    return modelRef;
  };
  const providerAutoChoiceId = parseProviderAutoSetupChoiceId(kind);
  if (providerAutoChoiceId) {
    const choice = (
      params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice
    )(providerAutoChoiceId, {
      config: cfg,
      workspaceDir: params.pluginWorkspaceDir,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    });
    if (
      !choice ||
      choice.appGuidedDiscovery !== true ||
      !supportsSetupTextInference(choice.onboardingScopes)
    ) {
      return { error: "That detected provider is no longer available on this Gateway." };
    }
    const providerChoice = await prepareSetupProviderAuthChoice(params, choice);
    if (providerChoice.error !== undefined) {
      return { error: providerChoice.error };
    }
    const { enableResult, provider, method } = providerChoice;
    if (!provider || !method?.appGuidedSetup) {
      return { error: "That detected provider is no longer available on this Gateway." };
    }
    const modelRef = params.modelRef?.trim();
    if (!modelRef) {
      return { error: "The detected provider model is missing. Run detection again." };
    }
    try {
      const result = await method.appGuidedSetup.prepare({
        config: enableResult.config,
        env: process.env,
        workspaceDir: params.pluginWorkspaceDir,
        modelRef,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const preparedModelRef = result?.defaultModel
        ? normalizeAgentModelRefForConfig(result.defaultModel)
        : "";
      if (!result || preparedModelRef !== modelRef) {
        return {
          error: `${choice.choiceLabel} could not prepare the detected model. Run detection again.`,
        };
      }
      const ref = parseRef(modelRef);
      if (
        !ref.model ||
        normalizeProviderId(ref.provider) !== normalizeProviderId(choice.providerId)
      ) {
        return { error: `${choice.choiceLabel} returned an invalid detected model.` };
      }
      const preparedConfig = applyProviderPluginAuthMethodResultConfig({
        config: enableResult.config,
        result,
      });
      return buildPreparedProviderTestPlan({
        cfg,
        sourceCfg: params.sourceCfg,
        preparedConfig,
        profiles: result.profiles,
        modelRef,
        pluginId: choice.pluginId,
        agentDir: params.agentDir,
        routeAgentId,
      });
    } catch (error) {
      return {
        error: `${choice.choiceLabel} could not prepare app-guided setup: ${formatErrorMessage(error)}`,
      };
    }
  }
  switch (kind) {
    case "claude-cli":
    case "gemini-cli":
    case "openai-api-key":
    case "anthropic-api-key": {
      const modelRef = resolveRouteModelRef(
        {
          "claude-cli": CLAUDE_CLI_DEFAULT_MODEL_REF,
          "gemini-cli": GEMINI_CLI_DEFAULT_MODEL_REF,
          "openai-api-key": OPENAI_API_DEFAULT_MODEL_REF,
          "anthropic-api-key": ANTHROPIC_API_DEFAULT_MODEL_REF,
        }[kind],
      );
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      // Only a registered CLI alias changes the provider persisted by this choice.
      const persistProvider =
        kind === "claude-cli"
          ? (resolveCliRuntimeCanonicalProvider({
              runtime: ref.provider,
              config: cfg,
              env: process.env,
              includeSetupRegistry: true,
            }) ?? ref.provider)
          : ref.provider;
      return {
        runner: kind === "claude-cli" || kind === "gemini-cli" ? "cli" : "embedded",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "openclaw",
        routeAgentId,
        persistModelRef: `${persistProvider}/${ref.model}`,
      };
    }
    case "codex-cli": {
      const modelRef = resolveRouteModelRef(CODEX_APP_SERVER_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      const plan: SetupInferenceTestPlan = {
        runner: "embedded",
        ...ref,
        modelRef,
        agentHarnessRuntimeOverride: "codex",
        config: cfg,
        agentId: "openclaw",
        routeAgentId,
        agentDir: params.agentDir,
        cleanupBundleMcpOnRunEnd: true,
        persistModelRef: modelRef,
      };
      if (params.codexCliApiKey) {
        const preparedAuth = prepareManualAuthForActivation({
          baseConfig: cfg,
          preparedConfig: cfg,
          profiles: [
            {
              profileId: "openai:codex-cli-api-key",
              credential: params.codexCliApiKey,
            },
          ],
          selectedProfileId: "openai:codex-cli-api-key",
          modelRef,
          targetModelRef: modelRef,
          providerId: ref.provider,
          agentId: routeAgentId,
        });
        plan.config = preparedAuth.config;
        plan.authProfileId = preparedAuth.selectedProfileId;
        plan.manualAuth = {
          profiles: preparedAuth.profiles,
          sourceConfigBase: params.sourceCfg,
          configPatch: createMergePatch(cfg, preparedAuth.config),
        };
      }
      return plan;
    }
    case "api-key":
    case "provider-auth": {
      const interactive = kind === "provider-auth";
      const apiKey = params.apiKey?.trim();
      if (!interactive && !apiKey) {
        return { error: "Enter an API key or token first." };
      }
      const authChoice = params.authChoice?.trim();
      if (interactive && authChoice === "custom-api-key") {
        if (params.isRemoteProviderAuth) {
          return {
            error:
              "For a custom provider, run openclaw onboard --auth-choice custom-api-key on the Gateway host, then return here and refresh connections.",
          };
        }
        if (!params.prompter) {
          return { error: "Custom provider setup requires an interactive setup session." };
        }
        const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
        throwIfSetupInferenceCancelled(params);
        const prepared = await waitForProviderAuth(
          promptCustomApiConfig({
            config: cfg,
            runtime: params.runtime,
            prompter: params.prompter,
            target: {
              agentId: routeAgentId,
              agentDir: params.agentDir,
              workspaceDir: params.pluginWorkspaceDir,
            },
            // Endpoint verification prepares config; only the real completion may select it.
            setAsPrimary: false,
          }),
          params.signal,
        );
        throwIfSetupInferenceCancelled(params);
        return buildPreparedProviderTestPlan({
          ...params,
          preparedConfig: prepared.config,
          profiles: [],
          modelRef: `${prepared.providerId}/${prepared.modelId}`,
          routeAgentId,
        });
      }
      const choice = authChoice
        ? (params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
            authChoice,
            {
              config: cfg,
              workspaceDir: params.pluginWorkspaceDir,
              includeUntrustedWorkspacePlugins: false,
              includeWorkspacePlugins: false,
            },
          )
        : undefined;
      const installEntry = authChoice
        ? resolveProviderInstallCatalogEntry(authChoice, {
            config: cfg,
            workspaceDir: params.pluginWorkspaceDir,
            includeUntrustedWorkspacePlugins: false,
          })
        : undefined;
      const managedWizardChoice = !choice
        ? installEntry && supportsSetupTextInference(installEntry.onboardingScopes)
          ? installEntry
          : undefined
        : supportsSetupTextInference(choice.onboardingScopes) &&
            (choice.appGuidedSecret === true ||
              (!choice.appGuidedAuth && choice.appGuidedDiscovery !== true))
          ? { pluginId: choice.pluginId, label: choice.groupLabel ?? choice.choiceLabel }
          : undefined;
      if (interactive && authChoice && managedWizardChoice) {
        if (!params.prompter) {
          return { error: "Installing this provider requires an interactive setup session." };
        }
        throwIfSetupInferenceCancelled(params);
        const prepared = await prepareAuthChoiceLoadedPluginProvider({
          authChoice,
          config: cfg,
          prompter: params.prompter,
          runtime: params.runtime,
          agentDir: params.agentDir,
          agentId: routeAgentId,
          workspaceDir: params.pluginWorkspaceDir,
          setDefaultModel: false,
          preserveExistingDefaultModel: true,
          ...(params.signal ? { signal: params.signal } : {}),
          isRemote: params.isRemoteProviderAuth,
          ...(params.beforePersistentEffect
            ? { beforePersistentEffect: params.beforePersistentEffect }
            : {}),
        });
        throwIfSetupInferenceCancelled(params);
        const modelRef = prepared?.agentModelOverride?.trim();
        if (!prepared || prepared.retrySelection || !modelRef) {
          return {
            error:
              prepared?.installError ||
              `${managedWizardChoice.label} was not installed and configured. Review the installer details and try again.`,
          };
        }
        return buildPreparedProviderTestPlan({
          cfg,
          sourceCfg: params.sourceCfg,
          preparedConfig: prepared.config,
          profiles: prepared.authProfiles,
          providerPlugin: prepared.provider,
          modelRef,
          pluginId: managedWizardChoice.pluginId,
          routeAgentId,
          agentDir: params.agentDir,
          pendingPluginInstalls: prepared.pendingPluginInstalls,
        });
      }
      if (
        !choice ||
        !supportsSetupTextInference(choice.onboardingScopes) ||
        (!interactive && !supportsSetupManualSecret(choice)) ||
        (interactive &&
          (choice.assistantVisibility === "manual-only" ||
            (!choice.appGuidedAuth && choice.appGuidedDiscovery !== true)))
      ) {
        return {
          error: interactive
            ? "That provider setup is not available on this Gateway."
            : "That key-based provider is not available on this Gateway.",
        };
      }
      const providerChoice = await prepareSetupProviderAuthChoice(params, choice);
      if (providerChoice.error !== undefined) {
        return { error: providerChoice.error };
      }
      const { enableResult, provider, method } = providerChoice;
      const resolved = provider && method ? { provider, method } : null;
      if (
        !resolved ||
        !supportsSetupTextInference(resolved.method.wizard?.onboardingScopes) ||
        (interactive &&
          choice.appGuidedDiscovery !== true &&
          resolved.method.kind !== "oauth" &&
          resolved.method.kind !== "device_code")
      ) {
        return {
          error: interactive
            ? "That provider setup is not available on this Gateway."
            : "That key-based provider is not available on this Gateway.",
        };
      }
      let result: ProviderAuthResult;
      let preparedConfig: OpenClawConfig;
      try {
        if (interactive) {
          if (!params.prompter) {
            return { error: "This provider login requires an interactive setup session." };
          }
          throwIfSetupInferenceCancelled(params);
          result = await waitForProviderAuth(
            runProviderPluginAuthMethodUnpersisted({
              config: enableResult.config,
              runtime: params.runtime,
              ...(params.signal ? { signal: params.signal } : {}),
              isRemote: params.isRemoteProviderAuth,
              prompter: params.prompter,
              method: resolved.method,
              agentDir: params.agentDir,
              workspaceDir,
            }),
            params.signal,
          );
          throwIfSetupInferenceCancelled(params);
          preparedConfig = applyProviderPluginAuthMethodResultConfig({
            config: enableResult.config,
            result,
          });
          if (choice.appGuidedDiscovery === true) {
            const guidedSetup = resolved.method.appGuidedSetup;
            if (!guidedSetup) {
              return { error: "That provider setup is not available on this Gateway." };
            }
            const selectedModelRef = result.defaultModel
              ? normalizeAgentModelRefForConfig(result.defaultModel)
              : "";
            const candidate = selectedModelRef
              ? { modelRef: selectedModelRef }
              : await guidedSetup.detect({
                  config: preparedConfig,
                  env: process.env,
                  workspaceDir: params.pluginWorkspaceDir,
                  ...(params.signal ? { signal: params.signal } : {}),
                });
            if (!candidate) {
              return {
                error: `${resolved.provider.label} setup completed, but no compatible model was found. Add a compatible model and try again.`,
              };
            }
            const prepared = await guidedSetup.prepare({
              config: preparedConfig,
              env: process.env,
              workspaceDir: params.pluginWorkspaceDir,
              modelRef: candidate.modelRef,
              ...(params.signal ? { signal: params.signal } : {}),
            });
            const preparedModelRef = prepared?.defaultModel
              ? normalizeAgentModelRefForConfig(prepared.defaultModel)
              : "";
            if (!prepared || preparedModelRef !== candidate.modelRef) {
              return {
                error: `${resolved.provider.label} could not prepare its detected model. Try setup again.`,
              };
            }
            preparedConfig = applyProviderPluginAuthMethodResultConfig({
              config: preparedConfig,
              result: prepared,
            });
            const profiles = new Map(
              [...result.profiles, ...prepared.profiles].map((profile) => [
                profile.profileId,
                profile,
              ]),
            );
            result = { ...prepared, profiles: [...profiles.values()] };
          }
        } else if (resolved.method.kind === "api_key" || resolved.method.kind === "token") {
          result = await runProviderPluginAuthMethodUnpersisted({
            config: enableResult.config,
            runtime: params.runtime,
            prompter: createQuickstartNotePrompter(params.runtime),
            method: resolved.method,
            agentDir: params.agentDir,
            workspaceDir,
            secretInputMode: "plaintext",
            allowSecretRefPrompt: false,
            opts: { token: apiKey!, tokenProvider: resolved.provider.id },
          });
          preparedConfig = applyProviderPluginAuthMethodResultConfig({
            config: enableResult.config,
            result,
          });
        } else {
          const prepared = await runProviderManualSecretMethod({
            config: enableResult.config,
            baseConfig: cfg,
            choice,
            method: resolved.method,
            apiKey: apiKey!,
            agentDir: params.agentDir,
            workspaceDir,
          });
          result = prepared.result;
          preparedConfig = prepared.config;
        }
      } catch (error) {
        if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
          return { error: "Provider login was cancelled." };
        }
        const detail = error instanceof Error ? error.message : String(error);
        return {
          error: `${resolved.provider.label} could not prepare this ${interactive ? "login" : "credential"} for app-guided setup: ${detail}`,
        };
      }
      const modelRef = result.defaultModel
        ? normalizeAgentModelRefForConfig(result.defaultModel)
        : "";
      if (!modelRef) {
        return {
          error: `${resolved.provider.label} does not expose a starter model for app-guided setup.`,
        };
      }
      const ref = parseRef(modelRef);
      if (!ref.model) {
        return {
          error: `${resolved.provider.label} returned an invalid starter model.`,
        };
      }
      return buildPreparedProviderTestPlan({
        cfg,
        sourceCfg: params.sourceCfg,
        preparedConfig,
        profiles: result.profiles,
        modelRef,
        pluginId: resolved.provider.pluginId,
        ...(interactive && choice.appGuidedDiscovery === true
          ? {}
          : { providerPlugin: resolved.provider }),
        agentDir: params.agentDir,
        routeAgentId,
      });
    }
    default:
      return { error: `Unknown inference choice "${kind}".` };
  }
}
