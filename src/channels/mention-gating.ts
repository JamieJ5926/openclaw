import type { ChannelImplicitMentionsConfig } from "../config/types.channels.js";

export type InboundImplicitMentionKind =
  | "reply_to_bot"
  | "quoted_bot"
  | "bot_thread_participant"
  | "native";

export type InboundMentionFacts = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  /** Native recipient routing, resolved by the channel before implicit activation. */
  explicitAddress?: "self" | "other";
  hasAnyMention?: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
};

export type InboundMentionPolicy = {
  isGroup: boolean;
  requireMention: boolean;
  implicitMentions?: ChannelImplicitMentionsConfig;
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};

/** @deprecated Prefer the nested `{ facts, policy }` call shape for new code. */
export type ResolveInboundMentionDecisionFlatParams = InboundMentionFacts & InboundMentionPolicy;

export type ResolveInboundMentionDecisionNestedParams = {
  facts: InboundMentionFacts;
  policy: InboundMentionPolicy;
};

export type ResolveInboundMentionDecisionParams =
  | ResolveInboundMentionDecisionFlatParams
  | ResolveInboundMentionDecisionNestedParams;

export type InboundMentionDecision = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
  implicitMention: boolean;
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
  skipReason?: "addressed-to-other" | "mention-required";
};

export function implicitMentionKindWhen(
  kind: InboundImplicitMentionKind,
  enabled: boolean,
): InboundImplicitMentionKind[] {
  return enabled ? [kind] : [];
}

/** Translates positive implicit-mention policy into the evaluator's kind allowlist. */
export function allowedImplicitMentionKindsFromConfig(
  config: ChannelImplicitMentionsConfig,
): InboundImplicitMentionKind[] {
  return [
    ...implicitMentionKindWhen("reply_to_bot", config.replyToBot !== false),
    ...implicitMentionKindWhen("quoted_bot", config.quotedBot !== false),
    ...implicitMentionKindWhen("bot_thread_participant", config.threadParticipation !== false),
    "native",
  ];
}

function resolveMatchedImplicitMentionKinds(params: {
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
}): InboundImplicitMentionKind[] {
  const inputKinds = params.implicitMentionKinds ?? [];
  if (inputKinds.length === 0) {
    return [];
  }
  const allowedKinds = params.allowedImplicitMentionKinds
    ? new Set(params.allowedImplicitMentionKinds)
    : null;
  const matched: InboundImplicitMentionKind[] = [];
  for (const kind of inputKinds) {
    if (allowedKinds && !allowedKinds.has(kind)) {
      continue;
    }
    if (!matched.includes(kind)) {
      matched.push(kind);
    }
  }
  return matched;
}

function hasNestedMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): params is ResolveInboundMentionDecisionNestedParams {
  return "facts" in params && "policy" in params;
}

function normalizeMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): ResolveInboundMentionDecisionNestedParams {
  if (hasNestedMentionDecisionParams(params)) {
    return params;
  }
  const {
    canDetectMention,
    wasMentioned,
    explicitAddress,
    hasAnyMention,
    implicitMentionKinds,
    isGroup,
    requireMention,
    implicitMentions,
    allowedImplicitMentionKinds,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  } = params;
  return {
    facts: {
      canDetectMention,
      wasMentioned,
      explicitAddress,
      hasAnyMention,
      implicitMentionKinds,
    },
    policy: {
      isGroup,
      requireMention,
      implicitMentions,
      allowedImplicitMentionKinds,
      allowTextCommands,
      hasControlCommand,
      commandAuthorized,
    },
  };
}

export function resolveInboundMentionDecision(
  params: ResolveInboundMentionDecisionParams,
): InboundMentionDecision {
  const { facts, policy } = normalizeMentionDecisionParams(params);
  // Recipient routing precedes activation: a reply, wake word, or command
  // bypass cannot volunteer this bot for work explicitly assigned elsewhere.
  const addressedToOther = facts.explicitAddress === "other";
  const wasMentioned =
    !addressedToOther && (facts.explicitAddress === "self" || facts.wasMentioned);
  const allowedImplicitMentionKinds =
    policy.allowedImplicitMentionKinds ??
    (policy.implicitMentions
      ? allowedImplicitMentionKindsFromConfig(policy.implicitMentions)
      : undefined);
  const shouldBypassMention =
    !addressedToOther &&
    policy.isGroup &&
    policy.requireMention &&
    !wasMentioned &&
    !(facts.hasAnyMention ?? false) &&
    policy.allowTextCommands &&
    policy.commandAuthorized &&
    policy.hasControlCommand;
  const matchedImplicitMentionKinds = resolveMatchedImplicitMentionKinds({
    implicitMentionKinds: addressedToOther ? [] : facts.implicitMentionKinds,
    allowedImplicitMentionKinds,
  });
  const implicitMention = matchedImplicitMentionKinds.length > 0;
  const effectiveWasMentioned = wasMentioned || implicitMention || shouldBypassMention;
  const skipReason = addressedToOther
    ? "addressed-to-other"
    : policy.requireMention && facts.canDetectMention && !effectiveWasMentioned
      ? "mention-required"
      : undefined;
  return {
    implicitMention,
    matchedImplicitMentionKinds,
    effectiveWasMentioned,
    shouldBypassMention,
    shouldSkip: skipReason !== undefined,
    ...(skipReason ? { skipReason } : {}),
  };
}
