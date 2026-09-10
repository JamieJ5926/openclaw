import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import type { AgentHarnessPluginSelection } from "./harness/runtime-plugin-load-plan.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { retainPreparedModelRuntimeSnapshotResources } from "./prepared-model-runtime.resources.js";
import type {
  PreparedModelRuntimeLeaseOptions,
  PreparedModelRuntimeResourceClaim,
} from "./prepared-model-runtime.types.js";
export type PreparedModelSelectionContext = {
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  workspaceDir: string;
  assertCurrent: () => void;
  borrowPreparedRuntime: () => PreparedModelRuntimeSnapshot;
};

class PreparedModelSelectionError extends Error {
  readonly code = "runtime-unavailable";
}

/** Retain prepared config, catalog and runtime hooks through selection and its consuming operation. */
export async function acquirePreparedModelSelection(
  params: {
    cfg: OpenClawConfig | undefined;
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
    readOnly?: boolean;
    abortSignal?: AbortSignal;
    assertCurrent?: () => void;
    borrowPreparedRuntime?: () => PreparedModelRuntimeSnapshot;
    onAcquired?: (resources: PreparedModelRuntimeResourceClaim) => void;
  },
  runtimePluginSelections:
    | readonly AgentHarnessPluginSelection[]
    | NonNullable<PreparedModelRuntimeLeaseOptions["deriveRuntimePluginSelections"]>,
) {
  params.abortSignal?.throwIfAborted();
  params.assertCurrent?.();
  const borrowed = params.borrowPreparedRuntime?.();
  const config = params.cfg ?? borrowed?.config ?? {};
  const agentId = params.agentId ?? borrowed?.agentId ?? resolveDefaultAgentId(config);
  const agentDir =
    params.agentDir?.trim() || borrowed?.agentDir || resolveAgentDir(config, agentId);
  const requestedWorkspaceDir =
    params.workspaceDir ?? borrowed?.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId);
  if (
    borrowed &&
    (config !== borrowed.config ||
      agentId !== borrowed.agentId ||
      agentDir !== borrowed.agentDir ||
      requestedWorkspaceDir !== borrowed.workspaceDir)
  ) {
    throw new PreparedModelSelectionError(
      "Borrowed model runtime does not match the requested owner.",
    );
  }
  const deriveRuntimePluginSelections =
    typeof runtimePluginSelections === "function" ? runtimePluginSelections : undefined;
  const input: PreparedModelRuntimeInput = {
    config,
    agentId,
    agentDir,
    workspaceDir: requestedWorkspaceDir,
    preserveWorkspaceDirOnRefresh: params.workspaceDir !== undefined,
    loadRuntimePlugins: true,
    ...(typeof runtimePluginSelections === "function"
      ? {}
      : {
          runtimePluginSelections: runtimePluginSelections.map((selection) => ({
            ...selection,
            agentId,
          })),
        }),
  };
  const lease = borrowed
    ? undefined
    : params.readOnly
      ? await acquireReadOnlyPreparedModelRuntime(
          input,
          params.abortSignal,
          "static",
          deriveRuntimePluginSelections,
        )
      : await acquireAgentRunPreparedModelRuntime(input, {
          catalogMode: "static",
          abortSignal: params.abortSignal,
          deriveRuntimePluginSelections,
        });
  const borrowedResources =
    borrowed && params.onAcquired
      ? retainPreparedModelRuntimeSnapshotResources(borrowed)
      : undefined;
  let releaseResources = lease?.release ?? borrowedResources?.release;
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new PreparedModelSelectionError("Prepared model selection has ended.");
    }
    params.abortSignal?.throwIfAborted();
    params.assertCurrent?.();
    borrowedResources?.assertOpen();
    if (borrowed && params.borrowPreparedRuntime?.() !== borrowed) {
      throw new PreparedModelSelectionError("Borrowed model runtime changed during selection.");
    }
  };
  const release = () => {
    active = false;
    releaseResources?.();
  };
  try {
    if (releaseResources && params.onAcquired) {
      // Cleanup can outlive the result, including cancellation during acquisition.
      params.onAcquired({ release: releaseResources });
      releaseResources = undefined;
    }
    assertCurrent();
    const preparedModelRuntime = borrowed ?? lease!.snapshot;
    const workspaceDir =
      params.workspaceDir ?? preparedModelRuntime.workspaceDir ?? requestedWorkspaceDir;
    const context: PreparedModelSelectionContext = {
      preparedModelRuntime,
      workspaceDir,
      assertCurrent,
      borrowPreparedRuntime: () => {
        assertCurrent();
        const generation = getPreparedModelRuntimePluginGeneration();
        if (
          !generation ||
          getPreparedModelRuntimeBorrowedSnapshot(generation) !== preparedModelRuntime
        ) {
          throw new PreparedModelSelectionError(
            "Prepared model selection no longer owns this runtime.",
          );
        }
        return preparedModelRuntime;
      },
    };
    return {
      release,
      assertCurrent,
      run: async <T>(run: (context: PreparedModelSelectionContext) => Promise<T>): Promise<T> => {
        assertCurrent();
        const runSelected = () =>
          withPluginRuntimeGenerationScope(preparedModelRuntime, () => run(context));
        const result = lease
          ? await withPreparedModelRuntimePluginGenerationScope(
              lease.pluginGeneration,
              runSelected,
              () => (active ? preparedModelRuntime : undefined),
            )
          : await runSelected();
        assertCurrent();
        return result;
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

export async function withPreparedModelSelection<T>(
  params: Parameters<typeof acquirePreparedModelSelection>[0],
  runtimePluginSelections: Parameters<typeof acquirePreparedModelSelection>[1],
  run: (context: PreparedModelSelectionContext) => Promise<T>,
): Promise<T> {
  const acquired = await acquirePreparedModelSelection(params, runtimePluginSelections);
  try {
    return await acquired.run(run);
  } finally {
    acquired.release();
  }
}
