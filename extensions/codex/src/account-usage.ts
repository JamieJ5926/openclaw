import { isDeepStrictEqual } from "node:util";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { resolveCodexAppServerAuthProfileStore } from "./app-server/auth-profile.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { buildCodexAppServerUsageSnapshot } from "./app-server/rate-limits.js";
import { readCodexAppServerUsage } from "./app-server/request.js";

const paramsSchema = z
  .object({ agentId: z.string().min(1), profileId: z.string().min(1) })
  .strict();

export function registerCodexAccountUsage(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "codex.accountUsage",
    async ({ params, respond, context, signal, hasCurrentClientAuthority }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Expected agentId and profileId."),
        );
        return;
      }
      const { agentId, profileId } = parsed.data;
      const config = context.getRuntimeConfig();
      if (!listAgentIds(config).includes(agentId)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Unknown agent."));
        return;
      }
      try {
        const agentDir = resolveAgentDir(config, agentId);
        const readStore = () =>
          resolveCodexAppServerAuthProfileStore({ agentDir, authProfileId: profileId, config });
        const store = structuredClone(readStore());
        const credential = store.profiles[profileId];
        if (!credential || credential.provider !== "openai" || credential.type === "api_key") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "Select a saved Codex subscription login."),
          );
          return;
        }
        const assertCurrent = () => {
          if (
            signal?.aborted ||
            hasCurrentClientAuthority?.() === false ||
            context.getRuntimeConfig() !== config ||
            !isDeepStrictEqual(readStore().profiles[profileId], store.profiles[profileId])
          ) {
            throw new Error("Account credentials changed. Refresh Models and try again.");
          }
        };
        assertCurrent();
        const { start } = resolveCodexAppServerRuntimeOptions({
          pluginConfig: config.plugins?.entries?.codex?.config,
        });
        const usage = await readCodexAppServerUsage({
          agentDir,
          config,
          timeoutMs: 20_000,
          preparedAuth: { kind: "profile", profileId, store },
          authRequirement: "subscription",
          assertCurrent,
          // Account rows must never log into the operator's native Codex home or daemon.
          startOptions: {
            ...start,
            transport: "stdio",
            homeScope: "agent",
          },
        });
        assertCurrent();
        const snapshot = buildCodexAppServerUsageSnapshot(usage.rateLimits, {
          accountDetails: true,
        });
        respond(true, { updatedAt: Date.now(), providers: [snapshot] });
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error
              ? error.message
              : "Codex usage unavailable. Try refreshing the account.",
          ),
        );
      }
    },
    { scope: "operator.admin" },
  );
}
