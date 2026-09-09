import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema telemetry config", () => {
  it("keeps both choices absent by default and preserves independent consent decisions", () => {
    expect(OpenClawSchema.parse({}).telemetry).toBeUndefined();
    expect(OpenClawSchema.parse({ telemetry: {} }).telemetry).toStrictEqual({});

    for (const enabled of [false, true]) {
      const telemetry = { enabled, consentedAt: "2026-08-23T12:00:00.000Z" };
      expect(OpenClawSchema.parse({ telemetry }).telemetry).toStrictEqual(telemetry);
      for (const runtimeUtcOffsetEnabled of [false, true]) {
        const separateConsent = {
          ...telemetry,
          runtimeUtcOffsetEnabled,
          runtimeUtcOffsetConsentedAt: "2026-09-09T12:00:00.000Z",
        };
        expect(OpenClawSchema.parse({ telemetry: separateConsent }).telemetry).toStrictEqual(
          separateConsent,
        );
      }
    }

    const offsetOnly = { runtimeUtcOffsetEnabled: true };
    expect(OpenClawSchema.parse({ telemetry: offsetOnly }).telemetry).toStrictEqual(offsetOnly);
  });

  it("rejects unknown telemetry fields and malformed consent timestamps", () => {
    expect(
      OpenClawSchema.safeParse({ telemetry: { enabled: true, installId: "hidden" } }).success,
    ).toBe(false);
    for (const key of ["consentedAt", "runtimeUtcOffsetConsentedAt"]) {
      expect(OpenClawSchema.safeParse({ telemetry: { [key]: "not-a-timestamp" } }).success).toBe(
        false,
      );
    }
    expect(
      OpenClawSchema.safeParse({ telemetry: { runtimeUtcOffsetEnabled: "true" } }).success,
    ).toBe(false);
  });

  it("projects schema-owned labels, help, docs, and the existing configuration tier", () => {
    const response = computeBaseConfigSchemaResponse({ generatedAt: "telemetry-metadata" });
    expect(response.uiHints["telemetry.enabled"]).toMatchObject({
      label: "Anonymous Feature Statistics",
      help: expect.stringContaining("Disabled by default"),
    });
    expect(response.uiHints["telemetry.consentedAt"]).toMatchObject({
      label: "Feature Statistics Consent Timestamp",
      help: expect.stringContaining("ISO timestamp"),
    });
    expect(response.uiHints["telemetry.runtimeUtcOffsetEnabled"]).toMatchObject({
      label: "Runtime UTC-Offset Buckets",
      help: expect.stringContaining("Disabled by default"),
      advanced: true,
    });
    expect(response.uiHints["telemetry.runtimeUtcOffsetConsentedAt"]).toMatchObject({
      label: "Runtime UTC-Offset Consent Timestamp",
      help: expect.stringContaining("Never sent"),
      advanced: true,
    });

    expect(response.uiHints.telemetry?.docsUrl).toBe("https://docs.openclaw.ai/gateway/telemetry");
    expect(response.uiHints["telemetry.enabled"]?.advanced).toBe(true);
  });
});
