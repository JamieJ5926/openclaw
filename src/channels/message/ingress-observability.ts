/** Core types and bounded metadata helpers for channel ingress observability. */

export const CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY = "ingressProgress";
export const CHANNEL_INGRESS_OBSERVABILITY_OWNER = "openclaw.channel-ingress";
export const CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION = 1;

export const CHANNEL_INGRESS_PREPARATION_STAGES = [
  "queued",
  "routing",
  "dedupe_wait",
  "user_channel_lookup",
  "thread_history",
  "media_preparation",
  "adoption",
  "execution",
  "delivery",
  "settlement",
] as const;

export type ChannelIngressPreparationStage = (typeof CHANNEL_INGRESS_PREPARATION_STAGES)[number];

export const CHANNEL_INGRESS_BLOCKERS = [
  "none",
  "slack_api",
  "rate_limit_sleep",
  "dedupe_owner",
  "previous_turn",
  "channel_migration",
  "approval",
  "model",
  "state_store",
  "unknown",
] as const;

export type ChannelIngressBlocker = (typeof CHANNEL_INGRESS_BLOCKERS)[number];

export const CHANNEL_INGRESS_OPERATION_KINDS = ["api", "dedupe", "sleep"] as const;

export type ChannelIngressOperationKind = (typeof CHANNEL_INGRESS_OPERATION_KINDS)[number];

export type ChannelIngressOperationOutcome = "completed" | "failed" | "cancelled" | "unknown";

export type ChannelIngressCorrelation = {
  providerEventType?: string;
  teamId?: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  sessionId?: string;
  runId?: string;
};

export type ChannelIngressOperationBegin = {
  phase: "begin";
  kind: ChannelIngressOperationKind;
  id?: string;
  method?: string;
  profile?: string;
  startedAt?: number;
};

export type ChannelIngressOperationFinish = {
  phase: "finish";
  id: string;
  finishedAt?: number;
  outcome?: ChannelIngressOperationOutcome;
};

export type ChannelIngressOperationRequest = {
  kind: ChannelIngressOperationKind;
  method?: string;
  profile?: string;
};

export type ChannelIngressProgressUpdate = {
  stage?: ChannelIngressPreparationStage;
  blocker?: ChannelIngressBlocker;
  stageStartedAt?: number;
  progressAt?: number;
  observedAt?: number;
  operation?: ChannelIngressOperationBegin | ChannelIngressOperationFinish;
  correlation?: ChannelIngressCorrelation;
};

export type ChannelIngressOperationSnapshot = {
  id: string;
  kind: ChannelIngressOperationKind;
  startedAt: number;
  method?: string;
  profile?: string;
};

export type ChannelIngressHistoricalOperationSnapshot = ChannelIngressOperationSnapshot & {
  historical: true;
  outcome?: ChannelIngressOperationOutcome;
  finishedAt?: number;
};

export type ChannelIngressProgressMetadataV1 = {
  owner: typeof CHANNEL_INGRESS_OBSERVABILITY_OWNER;
  schemaVersion: typeof CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION;
  stage: ChannelIngressPreparationStage;
  blocker: ChannelIngressBlocker;
  stageStartedAt: number;
  lastProgressAt?: number;
  updatedAt: number;
  activeOperations?: ChannelIngressOperationSnapshot[];
  lastOperation?: ChannelIngressHistoricalOperationSnapshot;
  lastPreparation?: {
    stage: ChannelIngressPreparationStage;
    blocker: ChannelIngressBlocker;
    stageStartedAt: number;
    completedAt: number;
    elapsedMs: number;
  };
  correlation?: ChannelIngressCorrelation;
  terminal?: {
    disposition: "completed" | "failed";
    recordedAt: number;
  };
};

export type ChannelIngressSnapshotEvent = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  status: "pending" | "claimed";
  receivedAt: number;
  receiptAgeMs: number;
  stage: ChannelIngressPreparationStage | "unknown";
  blocker: ChannelIngressBlocker;
  progressKnown: boolean;
  updatedAt: number;
  stageStartedAt?: number;
  stageAgeMs?: number;
  lastProgressAt?: number;
  noProgressAgeMs?: number;
  claimedAt?: number;
  claimedAgeMs?: number;
  correlation?: ChannelIngressCorrelation;
  lastOperation?: ChannelIngressHistoricalOperationSnapshot;
};

export type ChannelIngressBlockerSnapshot = {
  blocker: ChannelIngressBlocker;
  total: number;
  pending: number;
  claimed: number;
  oldestReceiptAgeMs?: number;
};

export type ChannelIngressStageSnapshot = {
  stage: ChannelIngressPreparationStage;
  total: number;
  pending: number;
  claimed: number;
  unknownProgress: number;
  oldestReceiptAgeMs?: number;
  eligibleNoProgressCount: number;
  maxEligibleNoProgressAgeMs?: number;
  blockers: Record<ChannelIngressBlocker, ChannelIngressBlockerSnapshot>;
  oldest?: ChannelIngressSnapshotEvent;
};

export type ChannelIngressUnknownProgressSnapshot = Omit<ChannelIngressStageSnapshot, "stage"> & {
  stage: "unknown";
};

export type ChannelIngressObservationRecordRef = {
  eventId: string;
  queueName?: string;
  channelId?: string;
  accountId?: string;
};

export type ChannelIngressActiveOperationSnapshot = ChannelIngressOperationSnapshot &
  ChannelIngressObservationRecordRef;

export type ChannelIngressOldestOperationSnapshot = ChannelIngressActiveOperationSnapshot & {
  ageMs: number;
};

export type ChannelIngressOperationAggregate = {
  kind: ChannelIngressOperationKind;
  total: number;
  known: boolean;
  truncated: boolean;
  overflowCount: number;
  oldestAgeMs?: number;
  oldest?: ChannelIngressOldestOperationSnapshot;
};

export type ChannelIngressActiveOperationsSnapshot = {
  operations: readonly ChannelIngressActiveOperationSnapshot[];
  overflowByKind?: Partial<Record<ChannelIngressOperationKind, number>>;
  unknownProgressEvents?: readonly ChannelIngressObservationRecordRef[];
};

export type ChannelIngressObservabilitySnapshot = {
  type: "ingress.snapshot";
  schemaVersion: typeof CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION;
  sampledAt: number;
  status: "known" | "unknown";
  isolationAvailable: false;
  failedCount: number;
  stages: Record<ChannelIngressPreparationStage, ChannelIngressStageSnapshot>;
  unknown: ChannelIngressUnknownProgressSnapshot;
  operations: Record<ChannelIngressOperationKind, ChannelIngressOperationAggregate>;
};

type MetadataObject = Record<string, unknown>;

export type ChannelIngressObservabilityRow = {
  event_id: string;
  channel_id: string;
  account_id: string;
  queue_name: string;
  status: string;
  metadata_json: string | null;
  received_at: number;
  updated_at: number;
  claimed_at: number | null;
  failed_at?: number | null;
};

const STAGE_SET = new Set<string>(CHANNEL_INGRESS_PREPARATION_STAGES);
const BLOCKER_SET = new Set<string>(CHANNEL_INGRESS_BLOCKERS);
const OPERATION_KIND_SET = new Set<string>(CHANNEL_INGRESS_OPERATION_KINDS);
const STRING_LIMIT = 160;
const MAX_ACTIVE_OPERATIONS = 8;
const NO_PROGRESS_INELIGIBLE_BLOCKERS = new Set<ChannelIngressBlocker>([
  "previous_turn",
  "channel_migration",
  "approval",
  "model",
]);
const NO_PROGRESS_INELIGIBLE_STAGES = new Set<ChannelIngressPreparationStage>([
  "execution",
  "delivery",
  "settlement",
]);

function hasOwnMetadataKey(metadata: MetadataObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(metadata, key);
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > STRING_LIMIT ? `${trimmed.slice(0, STRING_LIMIT)}...` : trimmed;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function isMetadataObject(value: unknown): value is MetadataObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadataObject(metadataJson: string | null): MetadataObject | null {
  if (metadataJson === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return isMetadataObject(parsed) ? { ...parsed } : null;
  } catch {
    return null;
  }
}

function parseStage(value: unknown): ChannelIngressPreparationStage | undefined {
  return typeof value === "string" && STAGE_SET.has(value)
    ? (value as ChannelIngressPreparationStage)
    : undefined;
}

function parseBlocker(value: unknown): ChannelIngressBlocker | undefined {
  return typeof value === "string" && BLOCKER_SET.has(value)
    ? (value as ChannelIngressBlocker)
    : undefined;
}

function parseOperationKind(value: unknown): ChannelIngressOperationKind | undefined {
  return typeof value === "string" && OPERATION_KIND_SET.has(value)
    ? (value as ChannelIngressOperationKind)
    : undefined;
}

function parseOperationOutcome(value: unknown): ChannelIngressOperationOutcome | undefined {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "unknown"
    ? value
    : undefined;
}

function parseCorrelation(value: unknown): ChannelIngressCorrelation | undefined {
  if (!isMetadataObject(value)) {
    return undefined;
  }
  const correlation: ChannelIngressCorrelation = {};
  const providerEventType = boundedString(value.providerEventType);
  const teamId = boundedString(value.teamId);
  const channelId = boundedString(value.channelId);
  const messageTs = boundedString(value.messageTs);
  const threadTs = boundedString(value.threadTs);
  const sessionId = boundedString(value.sessionId);
  const runId = boundedString(value.runId);
  if (providerEventType) {
    correlation.providerEventType = providerEventType;
  }
  if (teamId) {
    correlation.teamId = teamId;
  }
  if (channelId) {
    correlation.channelId = channelId;
  }
  if (messageTs) {
    correlation.messageTs = messageTs;
  }
  if (threadTs) {
    correlation.threadTs = threadTs;
  }
  if (sessionId) {
    correlation.sessionId = sessionId;
  }
  if (runId) {
    correlation.runId = runId;
  }
  return Object.keys(correlation).length === 0 ? undefined : correlation;
}

function parseOperationSnapshot(value: unknown): ChannelIngressOperationSnapshot | undefined {
  if (!isMetadataObject(value)) {
    return undefined;
  }
  const id = boundedString(value.id);
  const kind = parseOperationKind(value.kind);
  const startedAt = finiteTimestamp(value.startedAt);
  if (!id || !kind || startedAt === undefined) {
    return undefined;
  }
  const method = boundedString(value.method);
  const profile = boundedString(value.profile);
  return {
    id,
    kind,
    startedAt,
    ...(method ? { method } : {}),
    ...(profile ? { profile } : {}),
  };
}

function toHistoricalOperation(
  operation: ChannelIngressOperationSnapshot,
  params: { outcome?: ChannelIngressOperationOutcome; finishedAt?: number } = {},
): ChannelIngressHistoricalOperationSnapshot {
  return {
    ...operation,
    historical: true,
    ...(params.outcome ? { outcome: params.outcome } : {}),
    ...(params.finishedAt === undefined ? {} : { finishedAt: params.finishedAt }),
  };
}

function parseHistoricalOperation(value: unknown): ChannelIngressHistoricalOperationSnapshot | undefined {
  const operation = parseOperationSnapshot(value);
  if (!operation || !isMetadataObject(value) || value.historical !== true) {
    return undefined;
  }
  const outcome = parseOperationOutcome(value.outcome);
  const finishedAt = finiteTimestamp(value.finishedAt);
  return toHistoricalOperation(operation, {
    ...(outcome ? { outcome } : {}),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  });
}

function parseMetadataRoot(metadataJson: string | null): {
  metadata: MetadataObject | null;
  preserveOriginal: string | null;
} {
  if (metadataJson === null) {
    return { metadata: {}, preserveOriginal: null };
  }
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return isMetadataObject(parsed)
      ? { metadata: { ...parsed }, preserveOriginal: null }
      : { metadata: null, preserveOriginal: metadataJson };
  } catch {
    return { metadata: null, preserveOriginal: metadataJson };
  }
}

function mergeCorrelation(
  previous: ChannelIngressCorrelation | undefined,
  update: ChannelIngressCorrelation | undefined,
): ChannelIngressCorrelation | undefined {
  const parsedUpdate = parseCorrelation(update);
  const merged = { ...(previous ?? {}), ...(parsedUpdate ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function parseLastPreparation(value: unknown): ChannelIngressProgressMetadataV1["lastPreparation"] {
  if (!isMetadataObject(value)) {
    return undefined;
  }
  const stage = parseStage(value.stage);
  const blocker = parseBlocker(value.blocker);
  const stageStartedAt = finiteTimestamp(value.stageStartedAt);
  const completedAt = finiteTimestamp(value.completedAt);
  const elapsedMs = finiteTimestamp(value.elapsedMs);
  if (!stage || !blocker || stageStartedAt === undefined || completedAt === undefined || elapsedMs === undefined) {
    return undefined;
  }
  return { stage, blocker, stageStartedAt, completedAt, elapsedMs };
}

export function readChannelIngressProgressMetadata(
  metadataJson: string | null,
): ChannelIngressProgressMetadataV1 | undefined {
  const metadata = parseMetadataObject(metadataJson);
  if (metadata === null) {
    return undefined;
  }
  const raw = metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY];
  if (
    !isMetadataObject(raw) ||
    raw.owner !== CHANNEL_INGRESS_OBSERVABILITY_OWNER ||
    raw.schemaVersion !== CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION
  ) {
    return undefined;
  }
  const stage = parseStage(raw.stage);
  const blocker = parseBlocker(raw.blocker);
  const stageStartedAt = finiteTimestamp(raw.stageStartedAt);
  const updatedAt = finiteTimestamp(raw.updatedAt);
  if (!stage || !blocker || stageStartedAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const lastProgressAt = finiteTimestamp(raw.lastProgressAt);
  const activeOperations = Array.isArray(raw.activeOperations)
    ? raw.activeOperations.map(parseOperationSnapshot).filter((operation) => operation !== undefined)
    : undefined;
  const lastOperation = parseHistoricalOperation(raw.lastOperation);
  const lastPreparation = parseLastPreparation(raw.lastPreparation);
  const correlation = parseCorrelation(raw.correlation);
  const terminal = isMetadataObject(raw.terminal)
    ? (() => {
        const disposition = raw.terminal.disposition;
        const recordedAt = finiteTimestamp(raw.terminal.recordedAt);
        return (disposition === "completed" || disposition === "failed") && recordedAt !== undefined
          ? { disposition, recordedAt }
          : undefined;
      })()
    : undefined;
  return {
    owner: CHANNEL_INGRESS_OBSERVABILITY_OWNER,
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    stage,
    blocker,
    stageStartedAt,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    updatedAt,
    ...(activeOperations && activeOperations.length > 0 ? { activeOperations } : {}),
    ...(lastOperation ? { lastOperation } : {}),
    ...(lastPreparation ? { lastPreparation } : {}),
    ...(correlation ? { correlation } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

export function initializeChannelIngressProgressMetadata(
  metadataJson: string | null,
  receivedAt: number,
): string | null {
  const { metadata, preserveOriginal } = parseMetadataRoot(metadataJson);
  if (metadata === null) {
    return preserveOriginal;
  }
  if (hasOwnMetadataKey(metadata, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY)) {
    return metadataJson;
  }
  metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY] = {
    owner: CHANNEL_INGRESS_OBSERVABILITY_OWNER,
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    stage: "queued",
    blocker: "none",
    stageStartedAt: receivedAt,
    lastProgressAt: receivedAt,
    updatedAt: receivedAt,
  } satisfies ChannelIngressProgressMetadataV1;
  return JSON.stringify(metadata);
}

export function mergeChannelIngressProgressMetadata(
  metadataJson: string | null,
  update: ChannelIngressProgressUpdate,
  defaultObservedAt: number,
): string | null {
  const metadata = parseMetadataObject(metadataJson);
  if (metadata === null) {
    // Non-object provider metadata remains byte-for-byte owned by the provider.
    // The queue treats this as an unsupported observation write and leaves claim,
    // retry, and provider metadata unchanged while snapshots report unknown progress.
    return null;
  }
  const previous = readChannelIngressProgressMetadata(metadataJson);
  if (
    previous === undefined &&
    hasOwnMetadataKey(metadata, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY)
  ) {
    return null;
  }
  const observedAt = finiteTimestamp(update.observedAt) ?? defaultObservedAt;
  const stage = update.stage ?? previous?.stage ?? "queued";
  const blocker = update.blocker ?? previous?.blocker ?? "none";
  const stageChanged = previous?.stage !== undefined && previous.stage !== stage;
  const stageStartedAt =
    finiteTimestamp(update.stageStartedAt) ??
    (stageChanged ? observedAt : previous?.stageStartedAt) ??
    observedAt;
  let activeOperations = previous?.activeOperations ? [...previous.activeOperations] : [];
  let lastOperation = previous?.lastOperation;
  if (update.operation?.phase === "begin") {
    const id = boundedString(update.operation.id);
    const kind = parseOperationKind(update.operation.kind);
    const startedAt = finiteTimestamp(update.operation.startedAt) ?? observedAt;
    if (id && kind) {
      activeOperations = [
        ...activeOperations.filter((operation) => operation.id !== id),
        {
          id,
          kind,
          startedAt,
          ...(boundedString(update.operation.method) ? { method: boundedString(update.operation.method) } : {}),
          ...(boundedString(update.operation.profile) ? { profile: boundedString(update.operation.profile) } : {}),
        },
      ].slice(-MAX_ACTIVE_OPERATIONS);
    }
  } else if (update.operation?.phase === "finish") {
    const id = boundedString(update.operation.id);
    if (id) {
      const operation = activeOperations.find((entry) => entry.id === id);
      activeOperations = activeOperations.filter((entry) => entry.id !== id);
      if (operation) {
        lastOperation = toHistoricalOperation(operation, {
          outcome: update.operation.outcome ?? "completed",
          finishedAt: finiteTimestamp(update.operation.finishedAt) ?? observedAt,
        });
      }
    }
  }
  const correlation = mergeCorrelation(previous?.correlation, update.correlation);
  const lastProgressAt = finiteTimestamp(update.progressAt) ?? previous?.lastProgressAt;
  const lastPreparation =
    previous && stage === "adoption" && previous.stage !== "adoption"
      ? {
          stage: previous.stage,
          blocker: previous.blocker,
          stageStartedAt: previous.stageStartedAt,
          completedAt: observedAt,
          elapsedMs: Math.max(0, observedAt - previous.stageStartedAt),
        }
      : previous?.lastPreparation;
  const progress: ChannelIngressProgressMetadataV1 = {
    owner: CHANNEL_INGRESS_OBSERVABILITY_OWNER,
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    stage,
    blocker,
    stageStartedAt,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    updatedAt: observedAt,
    ...(activeOperations.length > 0 ? { activeOperations } : {}),
    ...(lastOperation ? { lastOperation } : {}),
    ...(lastPreparation ? { lastPreparation } : {}),
    ...(correlation ? { correlation } : {}),
    ...(previous?.terminal ? { terminal: previous.terminal } : {}),
  };
  metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY] = progress;
  return JSON.stringify(metadata);
}

export function freezeChannelIngressProgressMetadata(params: {
  metadataJson: string | null;
  completedMetadata?: unknown;
  disposition: "completed" | "failed";
  reason?: string;
  recordedAt: number;
}): { metadataJson: string | null; completedMetadataJson: string | null } {
  const progress = readChannelIngressProgressMetadata(params.metadataJson);
  const terminalProgress = progress
    ? (() => {
        const { activeOperations, ...settledProgress } = progress;
        const terminalLastOperation =
          settledProgress.lastOperation ??
          (activeOperations?.[0]
            ? toHistoricalOperation(activeOperations[0], { outcome: "unknown" })
            : undefined);
        const completedLastPreparation =
          params.disposition !== "completed" || settledProgress.stage === "adoption"
            ? settledProgress.lastPreparation
            : {
                stage: settledProgress.stage,
                blocker: settledProgress.blocker,
                stageStartedAt: settledProgress.stageStartedAt,
                completedAt: params.recordedAt,
                elapsedMs: Math.max(0, params.recordedAt - settledProgress.stageStartedAt),
              };
        return {
          ...settledProgress,
          ...(params.disposition === "completed"
            ? {
                stage: "adoption" as const,
                blocker: "none" as const,
                stageStartedAt:
                  settledProgress.stage === "adoption"
                    ? settledProgress.stageStartedAt
                    : params.recordedAt,
                lastProgressAt: params.recordedAt,
              }
            : {}),
          ...(terminalLastOperation ? { lastOperation: terminalLastOperation } : {}),
          ...(completedLastPreparation ? { lastPreparation: completedLastPreparation } : {}),
          updatedAt: params.recordedAt,
          terminal: {
            disposition: params.disposition,
            recordedAt: params.recordedAt,
          },
        };
      })()
    : undefined;
  const completed =
    params.completedMetadata === undefined
      ? {}
      : isMetadataObject(params.completedMetadata)
        ? { ...params.completedMetadata }
        : params.completedMetadata;
  const completedMetadata =
    terminalProgress &&
    isMetadataObject(completed) &&
    !hasOwnMetadataKey(completed, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY)
      ? { ...completed, [CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY]: terminalProgress }
      : completed;
  const completedMetadataJson =
    params.completedMetadata === undefined && terminalProgress === undefined
      ? null
      : JSON.stringify(completedMetadata);

  const metadata = parseMetadataObject(params.metadataJson);
  if (metadata === null || terminalProgress === undefined) {
    return { metadataJson: params.metadataJson, completedMetadataJson };
  }
  metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY] = terminalProgress;
  return { metadataJson: JSON.stringify(metadata), completedMetadataJson };
}

export function clearChannelIngressProgressMetadata(metadataJson: string | null): string | null {
  const metadata = parseMetadataObject(metadataJson);
  if (metadata === null) {
    return metadataJson;
  }
  if (
    hasOwnMetadataKey(metadata, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY) &&
    readChannelIngressProgressMetadata(metadataJson) === undefined
  ) {
    return metadataJson;
  }
  delete metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY];
  return Object.keys(metadata).length === 0 ? null : JSON.stringify(metadata);
}

function matchesObservationRecord(
  ref: ChannelIngressObservationRecordRef,
  row: ChannelIngressObservabilityRow,
): boolean {
  return (
    ref.eventId === row.event_id &&
    (ref.queueName === undefined || ref.queueName === row.queue_name) &&
    (ref.channelId === undefined || ref.channelId === row.channel_id) &&
    (ref.accountId === undefined || ref.accountId === row.account_id)
  );
}

function emptyStage(stage: ChannelIngressPreparationStage): ChannelIngressStageSnapshot {
  return {
    stage,
    total: 0,
    pending: 0,
    claimed: 0,
    unknownProgress: 0,
    eligibleNoProgressCount: 0,
    blockers: emptyBlockers(),
  };
}

function emptyBlockers(): Record<ChannelIngressBlocker, ChannelIngressBlockerSnapshot> {
  return Object.fromEntries(
    CHANNEL_INGRESS_BLOCKERS.map((blocker) => [
      blocker,
      { blocker, total: 0, pending: 0, claimed: 0 },
    ]),
  ) as Record<ChannelIngressBlocker, ChannelIngressBlockerSnapshot>;
}

function emptyOperation(kind: ChannelIngressOperationKind): ChannelIngressOperationAggregate {
  return { kind, total: 0, known: true, truncated: false, overflowCount: 0 };
}

function normalizeActiveOperationsSnapshot(
  activeOperations:
    | readonly ChannelIngressActiveOperationSnapshot[]
    | ChannelIngressActiveOperationsSnapshot
    | undefined,
): ChannelIngressActiveOperationsSnapshot {
  if (Array.isArray(activeOperations)) {
    return { operations: activeOperations };
  }
  return activeOperations ?? { operations: [] };
}

export function buildChannelIngressObservabilitySnapshot(params: {
  rows: readonly ChannelIngressObservabilityRow[];
  sampledAt: number;
  activeOperations?:
    | readonly ChannelIngressActiveOperationSnapshot[]
    | ChannelIngressActiveOperationsSnapshot;
  failedCount?: number;
  status?: "known" | "unknown";
}): ChannelIngressObservabilitySnapshot {
  const stages = Object.fromEntries(
    CHANNEL_INGRESS_PREPARATION_STAGES.map((stage) => [stage, emptyStage(stage)]),
  ) as Record<ChannelIngressPreparationStage, ChannelIngressStageSnapshot>;
  const operations = Object.fromEntries(
    CHANNEL_INGRESS_OPERATION_KINDS.map((kind) => [kind, emptyOperation(kind)]),
  ) as Record<ChannelIngressOperationKind, ChannelIngressOperationAggregate>;
  const unknown: ChannelIngressUnknownProgressSnapshot = {
    stage: "unknown",
    total: 0,
    pending: 0,
    claimed: 0,
    unknownProgress: 0,
    eligibleNoProgressCount: 0,
    blockers: emptyBlockers(),
  };
  const activeOperationState = normalizeActiveOperationsSnapshot(params.activeOperations);
  const unknownProgressEvents = activeOperationState.unknownProgressEvents ?? [];

  for (const row of params.rows) {
    if (row.status !== "pending" && row.status !== "claimed") {
      continue;
    }
    const progress = unknownProgressEvents.some((event) => matchesObservationRecord(event, row))
      ? undefined
      : readChannelIngressProgressMetadata(row.metadata_json);
    const snapshotEvent = toSnapshotEvent(row, progress, params.sampledAt);
    const aggregate = progress ? stages[progress.stage] : unknown;
    const rowStatus = row.status === "claimed" ? "claimed" : "pending";
    aggregate.total += 1;
    aggregate[rowStatus] += 1;
    if (!progress) {
      aggregate.unknownProgress += 1;
    }
    aggregate.oldestReceiptAgeMs = maxOptional(
      aggregate.oldestReceiptAgeMs,
      snapshotEvent.receiptAgeMs,
    );
    const blockerAggregate = aggregate.blockers[snapshotEvent.blocker];
    blockerAggregate.total += 1;
    blockerAggregate[rowStatus] += 1;
    blockerAggregate.oldestReceiptAgeMs = maxOptional(
      blockerAggregate.oldestReceiptAgeMs,
      snapshotEvent.receiptAgeMs,
    );
    if (isNoProgressEligible(progress) && snapshotEvent.noProgressAgeMs !== undefined) {
      aggregate.eligibleNoProgressCount += 1;
      aggregate.maxEligibleNoProgressAgeMs = maxOptional(
        aggregate.maxEligibleNoProgressAgeMs,
        snapshotEvent.noProgressAgeMs,
      );
    }
    if (!aggregate.oldest || snapshotEvent.receivedAt < aggregate.oldest.receivedAt) {
      aggregate.oldest = snapshotEvent;
    }
  }

  for (const activeOperation of activeOperationState.operations) {
    const operation = operations[activeOperation.kind];
    const ageMs = Math.max(0, params.sampledAt - activeOperation.startedAt);
    operation.total += 1;
    operation.oldestAgeMs = maxOptional(operation.oldestAgeMs, ageMs);
    if (!operation.oldest || activeOperation.startedAt < operation.oldest.startedAt) {
      operation.oldest = { ...activeOperation, ageMs };
    }
  }
  for (const kind of CHANNEL_INGRESS_OPERATION_KINDS) {
    const overflowCount = activeOperationState.overflowByKind?.[kind] ?? 0;
    if (overflowCount > 0) {
      operations[kind].total += overflowCount;
      operations[kind].overflowCount = overflowCount;
      operations[kind].truncated = true;
      operations[kind].known = false;
    }
  }

  return {
    type: "ingress.snapshot",
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    sampledAt: params.sampledAt,
    status: params.status ?? "known",
    isolationAvailable: false,
    failedCount: params.failedCount ?? 0,
    stages,
    unknown,
    operations,
  };
}

export function createUnknownChannelIngressObservabilitySnapshot(
  sampledAt: number,
): ChannelIngressObservabilitySnapshot {
  return buildChannelIngressObservabilitySnapshot({
    rows: [],
    sampledAt,
    status: "unknown",
  });
}

function toSnapshotEvent(
  row: ChannelIngressObservabilityRow,
  progress: ChannelIngressProgressMetadataV1 | undefined,
  sampledAt: number,
): ChannelIngressSnapshotEvent {
  const receiptAgeMs = Math.max(0, sampledAt - row.received_at);
  const base: ChannelIngressSnapshotEvent = {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    status: row.status === "claimed" ? "claimed" : "pending",
    receivedAt: row.received_at,
    receiptAgeMs,
    stage: progress?.stage ?? "unknown",
    blocker: progress?.blocker ?? "unknown",
    progressKnown: progress !== undefined,
    updatedAt: row.updated_at,
    ...(row.claimed_at === null
      ? {}
      : { claimedAt: row.claimed_at, claimedAgeMs: Math.max(0, sampledAt - row.claimed_at) }),
  };
  if (!progress) {
    return base;
  }
  return {
    ...base,
    stageStartedAt: progress.stageStartedAt,
    stageAgeMs: Math.max(0, sampledAt - progress.stageStartedAt),
    ...(progress.lastProgressAt === undefined
      ? {}
      : {
          lastProgressAt: progress.lastProgressAt,
          noProgressAgeMs: Math.max(0, sampledAt - progress.lastProgressAt),
        }),
    ...(progress.correlation ? { correlation: progress.correlation } : {}),
    ...(progress.lastOperation ? { lastOperation: progress.lastOperation } : {}),
  };
}

function isNoProgressEligible(progress: ChannelIngressProgressMetadataV1 | undefined): boolean {
  if (progress?.lastProgressAt === undefined) {
    return false;
  }
  return (
    !NO_PROGRESS_INELIGIBLE_BLOCKERS.has(progress.blocker) &&
    !NO_PROGRESS_INELIGIBLE_STAGES.has(progress.stage)
  );
}

function maxOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (right === undefined) {
    return left;
  }
  return left === undefined ? right : Math.max(left, right);
}

export type ChannelIngressLifecycleObserver = {
  stage: (stage: ChannelIngressPreparationStage, blocker?: ChannelIngressBlocker) => void;
  progress: (stage?: ChannelIngressPreparationStage, blocker?: ChannelIngressBlocker) => void;
  correlate: (correlation: ChannelIngressCorrelation) => void;
  begin: (operation: ChannelIngressOperationRequest) => {
    finish: (outcome?: ChannelIngressOperationOutcome) => void;
  };
};

export type ChannelIngressObserverController = ChannelIngressLifecycleObserver & {
  getActiveOperations: () => ChannelIngressActiveOperationSnapshot[];
  getActiveOperationSnapshot: () => ChannelIngressActiveOperationsSnapshot;
  revoke: () => void;
};

export async function observeChannelIngressDedupeWait<T>(
  observer: ChannelIngressLifecycleObserver | undefined,
  pending: Promise<T>,
): Promise<T> {
  let finish: ((outcome?: ChannelIngressOperationOutcome) => void) | undefined;
  try {
    observer?.stage("dedupe_wait", "dedupe_owner");
    finish = observer?.begin({ kind: "dedupe" }).finish;
  } catch {
    // Observability must not affect dedupe ownership or retry policy.
  }
  try {
    const result = await pending;
    try {
      finish?.("completed");
    } catch {
      // Observability must not affect dedupe ownership or retry policy.
    }
    return result;
  } catch (error) {
    try {
      finish?.("failed");
    } catch {
      // Observability must not affect dedupe ownership or retry policy.
    }
    throw error;
  }
}

export function createChannelIngressLifecycleObserver(params: {
  now: () => number;
  record: (update: ChannelIngressProgressUpdate) => Promise<boolean> | boolean;
  context?: Omit<ChannelIngressActiveOperationSnapshot, "id" | "kind" | "startedAt">;
  onError?: (error: unknown) => void;
}): ChannelIngressObserverController {
  const activeOperations = new Map<string, ChannelIngressActiveOperationSnapshot>();
  const overflowByKind = new Map<ChannelIngressOperationKind, number>();
  let closed = false;
  let recordFailed = false;
  let operationSequence = 0;
  const incrementOverflow = (kind: ChannelIngressOperationKind): void => {
    overflowByKind.set(kind, (overflowByKind.get(kind) ?? 0) + 1);
  };
  const decrementOverflow = (kind: ChannelIngressOperationKind): void => {
    const next = (overflowByKind.get(kind) ?? 0) - 1;
    if (next > 0) {
      overflowByKind.set(kind, next);
    } else {
      overflowByKind.delete(kind);
    }
  };
  const failObservation = (): void => {
    activeOperations.clear();
    overflowByKind.clear();
    recordFailed = true;
    closed = true;
  };
  const record = (update: ChannelIngressProgressUpdate): void => {
    if (closed) {
      return;
    }
    Promise.resolve()
      .then(() => params.record(update))
      .then((committed) => {
        if (!committed) {
          failObservation();
        }
      })
      .catch((error: unknown) => {
        failObservation();
        try {
          params.onError?.(error);
        } catch {
          // Observability must not corrupt ingress lifecycle ownership.
        }
      });
  };
  return {
    stage: (stage, blocker = "none") => {
      const observedAt = params.now();
      record({ stage, blocker, stageStartedAt: observedAt, observedAt });
    },
    progress: (stage, blocker) => {
      const observedAt = params.now();
      record({
        ...(stage ? { stage } : {}),
        ...(blocker ? { blocker } : {}),
        progressAt: observedAt,
        observedAt,
      });
    },
    correlate: (correlation) => record({ correlation, observedAt: params.now() }),
    begin: (operation) => {
      if (closed) {
        return { finish: () => {} };
      }
      const startedAt = params.now();
      const id = `${operation.kind}:${startedAt}:${operationSequence++}`;
      const overflowed = activeOperations.size >= MAX_ACTIVE_OPERATIONS;
      if (overflowed) {
        incrementOverflow(operation.kind);
      } else {
        activeOperations.set(id, {
          id,
          kind: operation.kind,
          startedAt,
          ...(boundedString(operation.method) ? { method: boundedString(operation.method) } : {}),
          ...(boundedString(operation.profile) ? { profile: boundedString(operation.profile) } : {}),
          ...params.context,
        });
      }
      record({
        operation: { ...operation, id, startedAt, phase: "begin" },
        observedAt: startedAt,
      });
      let finished = false;
      return {
        finish: (outcome = "completed") => {
          if (finished || closed) {
            return;
          }
          finished = true;
          const finishedAt = params.now();
          if (overflowed) {
            decrementOverflow(operation.kind);
          } else {
            activeOperations.delete(id);
          }
          record({
            operation: { phase: "finish", id, outcome, finishedAt },
            observedAt: finishedAt,
          });
        },
      };
    },
    getActiveOperations: () => (closed ? [] : [...activeOperations.values()]),
    getActiveOperationSnapshot: () => {
      if (closed && !recordFailed) {
        return { operations: [] };
      }
      const overflow = Object.fromEntries(overflowByKind.entries()) as Partial<
        Record<ChannelIngressOperationKind, number>
      >;
      return {
        operations: closed ? [] : [...activeOperations.values()],
        ...(Object.keys(overflow).length === 0 ? {} : { overflowByKind: overflow }),
        ...(recordFailed && params.context?.eventId
          ? { unknownProgressEvents: [params.context as ChannelIngressObservationRecordRef] }
          : {}),
      };
    },
    revoke: () => {
      activeOperations.clear();
      overflowByKind.clear();
      recordFailed = false;
      closed = true;
    },
  };
}
