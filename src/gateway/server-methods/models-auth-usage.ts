import {
  ErrorCodes,
  errorShape,
  validateModelsAuthUsageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import { readPreparedCatalog } from "../server-model-catalog-auth.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { loadProfileUsage } from "./models-auth-status-usage-cache.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const modelsAuthUsageHandlers: GatewayRequestHandlers = {
  "models.authUsage": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsAuthUsageParams, "models.authUsage", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const config = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(
        config,
        params.agentId ?? tryResolveAmbientOwnerAgentId(config),
      );
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const prepared = await readPreparedCatalog(context, scope.agentId);
      if (!prepared || !prepared.isCurrent()) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Model authentication is not prepared. Refresh Models after setup finishes.",
          ),
        );
        return;
      }
      const credential = prepared.authStore.profiles[params.profileId];
      if (!credential) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Unknown auth profile"));
        return;
      }
      const providerId = resolveUsageProviderId(credential.provider, {
        credentialType: credential.type,
      });
      const runtime = getProviderUsageRuntimeSnapshot({
        config: prepared.config,
        agentId: prepared.agentId,
        agentDir: prepared.agentDir,
        store: prepared.authStore,
      });
      const now = Date.now();
      if (
        !providerId ||
        !runtime.descriptors.some(
          (descriptor) => descriptor.provider === providerId && descriptor.supportsAccountUsage,
        )
      ) {
        respond(true, { updatedAt: now, providers: [] }, undefined);
        return;
      }
      respond(
        true,
        await loadProfileUsage({
          agentId: prepared.agentId,
          agentDir: prepared.agentDir,
          workspaceDir: prepared.workspaceDir,
          authStore: prepared.authStore,
          configRef: prepared.config,
          isCurrent: prepared.isCurrent,
          profileCredentialKeys: runtime.profileCredentialKeys,
          profileId: params.profileId,
          providerId,
          forceRefresh: params.refresh,
          now,
        }),
        undefined,
      );
    });
  },
};
