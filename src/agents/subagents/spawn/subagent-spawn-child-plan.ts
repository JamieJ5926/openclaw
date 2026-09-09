import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { inheritSessionCreationPolicy } from "../../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveAgentDir } from "../../agent-scope-config.js";
import { findModelCatalogEntry } from "../../model-catalog-lookup.js";
import { resolveSubagentSpawnModelInput } from "../../model-selection-config.js";
import {
  buildModelAliasIndex,
  findNormalizedProviderValue,
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.types.js";
import { withPreparedModelSelection } from "../../prepared-model-selection.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import { resolveSpawnSandboxError, mintSpawnSessionKey } from "../../spawn-plan.js";
import { resolveRequesterOriginForChild } from "../../spawn-requester-origin.js";
import {
  mapToolContextToSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "../../spawned-context.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { resolveSubagentModelAndThinkingPlan } from "./subagent-spawn-plan.js";
import {
  readRequesterFastMode,
  readRequesterThinkingLevel,
} from "./subagent-spawn-requester-prefs.js";
import {
  normalizeDeliveryContext,
  resolveAgentConfig,
  resolveSandboxRuntimeStatus,
} from "./subagent-spawn.runtime.js";

async function resolveSpawnModelSelection(params: {
  runtime: PreparedModelRuntimeSnapshot;
  targetAgentId: string;
  workspaceDir: string;
  request: SpawnSubagentParams;
  modelInput: string;
}): Promise<Result<ModelRef, string>> {
  const { runtime, targetAgentId, modelInput } = params;
  const cfg = runtime.config;
  let catalog = runtime.modelCatalog.entries;
  if (params.request.model?.trim() || params.request.outputSchema) {
    try {
      catalog = await getSubagentSpawnDeps().readPreparedModelCatalog({
        config: cfg,
        agentId: targetAgentId,
        agentDir: runtime.agentDir,
        workspaceDir: params.workspaceDir,
        readOnly: true,
      });
    } catch (error) {
      return err(
        `sessions_spawn could not verify the selected model: ${summarizeSpawnError(error)}`,
      );
    }
  }
  const defaults = resolveDefaultModelForAgent({
    cfg,
    agentId: targetAgentId,
    manifestPlugins: runtime.metadataSnapshot,
    resolvedModelCatalog: catalog,
  });
  const selection = {
    cfg,
    catalog,
    raw: modelInput,
    defaultProvider: defaults.provider,
    defaultModel: defaults.model,
    agentId: targetAgentId,
    manifestPlugins: runtime.metadataSnapshot,
    resolvedModelCatalog: catalog,
  };
  // Configured defaults are operator selections; override policy applies only
  // to an explicit request, including when outputSchema needs capability proof.
  const resolved = params.request.model?.trim()
    ? resolveAllowedModelRef(selection)
    : (resolveModelRefFromString({
        ...selection,
        aliasIndex: buildModelAliasIndex(selection),
      }) ?? { error: `invalid model: ${modelInput}` });
  if ("error" in resolved) {
    return err(`sessions_spawn model "${modelInput}" is not usable: ${resolved.error}`);
  }
  const { provider, model } = resolved.ref;
  const entry = findModelCatalogEntry(catalog, { provider, modelId: model });
  if (
    !entry &&
    !findNormalizedProviderValue(cfg.models?.providers, provider) &&
    !catalog.some((candidate) => candidate.provider === provider) &&
    getSubagentSpawnDeps().resolveProviderRefOwnership({
      provider,
      config: cfg,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: runtime.metadataSnapshot,
    }).status !== "owned"
  ) {
    return err(
      `sessions_spawn model "${modelInput}" is not usable: unknown model provider "${provider}"`,
    );
  }
  if (params.request.outputSchema && entry && !supportsModelTools(entry)) {
    return err(
      `sessions_spawn outputSchema requires a tool-capable target model; "${provider}/${model}" declares compat.supportsTools=false.`,
    );
  }
  return ok(resolved.ref);
}

type ResolvedSubagentChildPlan = {
  spawnedCwd?: string;
  toolSpawnMetadata: ReturnType<typeof mapToolContextToSpawnedRunMetadata>;
  spawnedWorkspaceDir?: string;
  requesterOrigin: ReturnType<typeof normalizeDeliveryContext>;
  childSessionOrigin: ReturnType<typeof resolveRequesterOriginForChild>;
  incognito: boolean;
  childSessionKey: string;
  childRuntimeSandboxed: boolean;
  creationPolicy: ReturnType<typeof inheritSessionCreationPolicy>;
  targetAgentDir: string;
  modelPlan: Extract<
    Awaited<ReturnType<typeof resolveSubagentModelAndThinkingPlan>>,
    { status: "ok" }
  >;
  launchAuthorization?: SubagentLaunchAuthorization;
  resolvedModelMetadata: { resolvedModel: string; resolvedProvider: string };
};

type ResolveSubagentChildPlanResult =
  | { ok: false; result: SpawnSubagentResult }
  | { ok: true; resolved: ResolvedSubagentChildPlan };

export async function resolveSubagentChildPlan(params: {
  request: SpawnSubagentParams;
  ctx: SpawnSubagentContext;
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  sandboxMode: "require" | "inherit";
  swarmEnabled: boolean;
  /** Active requester sandbox classification from the spawn tool, preferred over key-derived
   * status so durable-lineage key substitution does not weaken sandbox admission. */
  requesterSandboxed?: boolean;
}): Promise<ResolveSubagentChildPlanResult> {
  const requestedCwd = normalizeOptionalString(params.request.cwd);
  const spawnedCwd = requestedCwd ? resolveUserPath(requestedCwd) : undefined;
  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
    agentGroupId: params.ctx.agentGroupId,
    agentGroupChannel: params.ctx.agentGroupChannel,
    agentGroupSpace: params.ctx.agentGroupSpace,
    workspaceDir: params.ctx.workspaceDir,
  });
  const inheritedWorkspaceDir =
    params.targetAgentId !== params.requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir;
  const spawnedWorkspaceDir = resolveSpawnedWorkspaceInheritance({
    config: params.cfg,
    targetAgentId: params.targetAgentId,
    explicitWorkspaceDir: inheritedWorkspaceDir,
  });
  const requesterOrigin = normalizeDeliveryContext({
    channel: params.ctx.agentChannel,
    accountId: params.ctx.agentAccountId,
    to: params.ctx.agentTo,
    ...(params.ctx.agentThreadId != null && params.ctx.agentThreadId !== ""
      ? { threadId: params.ctx.agentThreadId }
      : {}),
  });
  const childSessionOrigin = resolveRequesterOriginForChild({
    cfg: params.cfg,
    targetAgentId: params.targetAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterChannel: params.ctx.agentChannel,
    requesterAccountId: params.ctx.agentAccountId,
    requesterTo: params.ctx.agentTo,
    requesterThreadId: params.ctx.agentThreadId,
    requesterGroupSpace: params.ctx.agentGroupSpace,
    requesterMemberRoleIds: params.ctx.agentMemberRoleIds,
  });
  const incognito = isIncognitoSessionKey(params.requesterInternalKey);
  const mintedChildSessionKey = mintSpawnSessionKey({
    targetAgentId: params.targetAgentId,
    backend: "subagent",
  });
  const childSessionKey = incognito
    ? mintedChildSessionKey.replace(":subagent:", ":subagent:incognito-")
    : mintedChildSessionKey;
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterInternalKey,
    agentId: params.requesterAgentId,
  });
  const creationPolicy = inheritSessionCreationPolicy(
    {
      sandbox: requesterRuntime.sandboxRequired ? "required" : undefined,
      createdActor: requesterRuntime.createdActor,
    },
    { type: "agent", id: params.requesterAgentId },
  );
  // A fresh child has no stored row yet; admission must include its inherited isolation.
  const childRuntimeSandboxed =
    creationPolicy.sandbox === "required" ||
    resolveSandboxRuntimeStatus({ cfg: params.cfg, sessionKey: childSessionKey }).sandboxed;
  const sandboxError = resolveSpawnSandboxError({
    backend: "subagent",
    // Prefer the explicit active classification from the spawn tool; fall back to key-derived
    // status. Mirrors the visible/ACP paths so durable parent-lineage keys do not reclassify
    // an actively sandboxed requester as unsandboxed.
    requesterSandboxed: params.requesterSandboxed === true || requesterRuntime.sandboxed,
    childSandboxed: childRuntimeSandboxed,
    sandbox: params.sandboxMode,
  });
  if (sandboxError) {
    return { ok: false, result: { status: "forbidden", error: sandboxError } };
  }
  const spawnedWorkspaceCwd = spawnedWorkspaceDir
    ? resolveUserPath(spawnedWorkspaceDir)
    : undefined;
  if (childRuntimeSandboxed && spawnedCwd && spawnedCwd !== spawnedWorkspaceCwd) {
    return {
      ok: false,
      result: {
        status: "forbidden",
        error:
          "cwd override is not supported for sandboxed subagent runs; omit cwd or use the target agent workspace as cwd",
      },
    };
  }
  const targetAgentDir = resolveAgentDir(params.cfg, params.targetAgentId);
  // The active turn owns inherited effort; saved preferences may already describe
  // a later turn and cannot represent one-shot overrides.
  const callerThinkingRaw =
    params.ctx.requesterThinkingLevel ??
    readRequesterThinkingLevel({
      cfg: params.cfg,
      requesterInternalKey: params.requesterInternalKey,
      requesterAgentId: params.requesterAgentId,
    });
  const inheritedFastMode =
    params.swarmEnabled && params.request.fastMode === undefined
      ? readRequesterFastMode({
          cfg: params.cfg,
          requesterInternalKey: params.requesterInternalKey,
          requesterAgentId: params.requesterAgentId,
        })
      : params.request.fastMode;
  const modelPlan = await withPreparedModelSelection(
    {
      cfg: params.cfg,
      agentId: params.targetAgentId,
      agentDir: targetAgentDir,
      workspaceDir: spawnedWorkspaceDir,
      assertCurrent: params.ctx.assertActive,
    },
    ({ config, metadataSnapshot }) => {
      const preparation = {
        cfg: config,
        agentId: params.targetAgentId,
        manifestPlugins: metadataSnapshot,
        allowPluginNormalization: false,
      };
      const defaultProvider = resolveDefaultModelForAgent(preparation).provider;
      const ref = resolveModelRefFromString({
        ...preparation,
        raw: resolveSubagentSpawnModelInput({
          ...preparation,
          modelOverride: params.request.model,
        }),
        defaultProvider,
        aliasIndex: buildModelAliasIndex({ ...preparation, defaultProvider }),
      });
      return ref
        ? [{ provider: ref.ref.provider, modelId: ref.ref.model, agentId: params.targetAgentId }]
        : [];
    },
    async ({ preparedModelRuntime: runtime, workspaceDir }) =>
      await resolveSubagentModelAndThinkingPlan({
        cfg: runtime.config,
        targetAgentId: params.targetAgentId,
        requesterAgentConfig: resolveAgentConfig(runtime.config, params.requesterAgentId),
        targetAgentConfig: resolveAgentConfig(runtime.config, params.targetAgentId),
        modelOverride: params.request.model,
        thinkingOverrideRaw: params.request.thinking,
        callerThinkingRaw,
        fastMode: inheritedFastMode,
        resolveModel: (modelInput) =>
          resolveSpawnModelSelection({
            runtime,
            targetAgentId: params.targetAgentId,
            workspaceDir,
            request: params.request,
            modelInput,
          }),
      }),
  );
  if (modelPlan.status === "error") {
    return {
      ok: false,
      result: {
        status: "error",
        error: modelPlan.error,
        ...(params.request.outputSchema ? { childSessionKey } : {}),
      },
    };
  }
  const launchAuthorization: SubagentLaunchAuthorization | undefined = params.request.model?.trim()
    ? { modelOverride: modelPlan.modelSelection }
    : undefined;
  return {
    ok: true,
    resolved: {
      spawnedCwd,
      toolSpawnMetadata,
      spawnedWorkspaceDir,
      requesterOrigin,
      childSessionOrigin,
      incognito,
      childSessionKey,
      childRuntimeSandboxed,
      creationPolicy,
      targetAgentDir,
      modelPlan,
      launchAuthorization,
      resolvedModelMetadata: {
        resolvedModel: modelPlan.resolvedModel,
        resolvedProvider: modelPlan.modelSelection.provider,
      },
    },
  };
}
