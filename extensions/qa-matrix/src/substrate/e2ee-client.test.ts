// Qa Matrix tests cover e2ee client plugin behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testing } from "./e2ee-client.js";
import { findMatrixQaObservedEventMatch } from "./events.js";

describe("matrix qa e2ee client storage", () => {
  it("filters receipt noise without suppressing room state or timeline events", () => {
    expect(testing.MATRIX_QA_E2EE_SYNC_FILTER).toEqual({
      room: {
        ephemeral: { not_types: ["m.receipt"] },
      },
    });
  });

  it("shares persisted crypto and sync state by actor account", () => {
    const first = testing.buildMatrixQaE2eeStoragePaths({
      actorId: "driver",
      outputDir: "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
      scenarioId: "matrix-e2ee-basic-reply",
    });
    const second = testing.buildMatrixQaE2eeStoragePaths({
      actorId: "driver",
      outputDir: "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
      scenarioId: "matrix-e2ee-qr-verification",
    });

    expect(first.accountDir).toBe(
      path.join(
        "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
        "matrix-e2ee",
        "accounts",
        "driver",
        "account",
      ),
    );
    expect(first.cryptoDatabasePrefix).toBe(second.cryptoDatabasePrefix);
    expect(first.recoveryKeyPath).toBe(path.join(first.accountDir, "recovery-key.json"));
    expect(first.storagePath).toBe(path.join(first.accountDir, "sync-store.json"));
    expect(second.storagePath).toBe(first.storagePath);
  });

  it("records late-decrypted payload updates for an existing event id", () => {
    const previous = {
      eventId: "$reply",
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
    };

    expect(
      testing.shouldRecordMatrixQaObservedEventUpdate({
        previous,
        next: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
      }),
    ).toBe(true);
    expect(
      testing.shouldRecordMatrixQaObservedEventUpdate({
        previous: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
        next: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
      }),
    ).toBe(false);
  });

  it("inherits replacement relations when the encrypted target arrives first", () => {
    const localEvents: Parameters<
      typeof testing.recordMatrixQaE2eeObservedEvent
    >[0]["localEvents"] = [];
    const observedEvents: typeof localEvents = [];
    const observedEventsById = new Map<string, (typeof localEvents)[number]>();
    const pendingReplacementIds = new Set<string>();
    const record = (
      event: Parameters<typeof testing.recordMatrixQaE2eeObservedEvent>[0]["event"],
    ) =>
      testing.recordMatrixQaE2eeObservedEvent({
        event,
        localEvents,
        observedEvents,
        observedEventsById,
        pendingReplacementIds,
        roomId: "!room:matrix-qa.test",
      });

    record({
      event_id: "$preview",
      origin_server_ts: 1,
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      content: {
        body: "preview",
        msgtype: "m.text",
        "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
      },
    });
    const replacement = record({
      event_id: "$final",
      origin_server_ts: 2,
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      content: {
        body: "* final",
        msgtype: "m.text",
        "m.new_content": { body: "final", msgtype: "m.text" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
      },
    });

    expect(replacement?.relatesTo).toEqual({ relType: "m.thread", eventId: "$thread-root" });
  });

  it("enriches an encrypted replacement when its target arrives late", () => {
    const localEvents: Parameters<
      typeof testing.recordMatrixQaE2eeObservedEvent
    >[0]["localEvents"] = [];
    const observedEvents: typeof localEvents = [];
    const observedEventsById = new Map<string, (typeof localEvents)[number]>();
    const pendingReplacementIds = new Set<string>();
    const record = (
      event: Parameters<typeof testing.recordMatrixQaE2eeObservedEvent>[0]["event"],
    ) =>
      testing.recordMatrixQaE2eeObservedEvent({
        event,
        localEvents,
        observedEvents,
        observedEventsById,
        pendingReplacementIds,
        roomId: "!room:matrix-qa.test",
      });

    const replacement = record({
      event_id: "$final",
      origin_server_ts: 1,
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      content: {
        body: "* final",
        msgtype: "m.text",
        "m.new_content": { body: "final", msgtype: "m.text" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
      },
    });
    expect(replacement?.relatesTo).toBeUndefined();
    expect(localEvents).toEqual([]);
    const waiterCursor = localEvents.length;
    expect(
      findMatrixQaObservedEventMatch({
        cursorIndex: waiterCursor,
        events: localEvents,
        predicate: (event) => event.body === "final" && event.relatesTo === undefined,
        roomId: "!room:matrix-qa.test",
      }),
    ).toBeUndefined();

    record({
      event_id: "$preview",
      origin_server_ts: 2,
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      content: {
        body: "preview",
        msgtype: "m.text",
        "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
      },
    });

    expect(localEvents).toHaveLength(2);
    expect(localEvents[1]).toMatchObject({
      eventId: "$final",
      relatesTo: { relType: "m.thread", eventId: "$thread-root" },
    });
    expect(observedEvents).toEqual(localEvents);
    expect(pendingReplacementIds.size).toBe(0);
    expect(
      findMatrixQaObservedEventMatch({
        cursorIndex: waiterCursor,
        events: localEvents,
        predicate: (event) => event.body === "final" && event.relatesTo?.eventId === "$thread-root",
        roomId: "!room:matrix-qa.test",
      })?.event.eventId,
    ).toBe("$final");
  });
});
