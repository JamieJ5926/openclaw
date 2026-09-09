import { describe, expect, it, vi } from "vitest";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";
import { readStoredModelOverride, resolveStoredModelOverride } from "./stored-model-overrides.js";

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: ({ context }: { context: { modelId: string } }) =>
    context.modelId === "latest" ? "middle" : context.modelId === "middle" ? "final" : undefined,
}));

describe("resolveStoredModelOverride", () => {
  it("preserves the exact namespaced selection written by the override owner", () => {
    const entry = { sessionId: "namespaced-selection", updatedAt: 1 };
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "custom", model: "custom/Model", isDefault: false },
    });
    expect(resolveStoredModelOverride({ defaultProvider: "openai", sessionEntry: entry })).toEqual({
      provider: "custom",
      model: "custom/Model",
      source: "session",
      routeResolution: "resolved",
    });
  });

  it("recovers resolved provenance for legacy auto-fallback overrides", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "legacy-fallback",
          updatedAt: 1,
          providerOverride: "cloudflare-ai-gateway",
          modelOverride: "gemini-2.5-flash-lite",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
      }),
    ).toMatchObject({ routeResolution: "resolved" });
  });

  it("loads parent overrides without requiring a whole session store", () => {
    const loadSessionEntry = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:telegram:dm:parent"
        ? {
            sessionId: "parent-session",
            updatedAt: 1782259200000,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-7",
          }
        : undefined,
    );

    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        loadSessionEntry,
        sessionKey: "agent:main:telegram:dm:parent:thread:child",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      source: "parent",
      routeResolution: "resolved",
    });
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:telegram:dm:parent");
  });

  it("does not inherit active automatic fallback overrides from parent sessions", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: "openai",
            modelOverrideFallbackOriginModel: "gpt-primary",
          },
        },
      }),
    ).toBeNull();
  });

  it("inherits configured automatic selections without fallback provenance", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "legacy-parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
          },
        },
      }),
    ).toEqual({
      provider: "google-vertex",
      model: "gemini-fallback",
      source: "parent",
      routeResolution: "raw",
    });
  });

  it.each(["user", undefined] as const)("inherits parent model pins with source=%s", (source) => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "custom",
            modelOverride: "middle",
            ...(source ? { modelOverrideSource: source } : {}),
          },
        },
      }),
    ).toEqual({
      provider: "custom",
      model: "middle",
      source: "parent",
      routeResolution: "resolved",
    });
  });

  it("rejects stale direct fields behind an explicit Default marker", () => {
    expect(
      readStoredModelOverride({
        sessionEntry: {
          sessionId: "default-session",
          updatedAt: 1,
          modelOverrideSource: "default",
          providerOverride: "anthropic",
          modelOverride: "stale-model",
        },
      }),
    ).toBeNull();
  });

  it("does not inherit stale fields from a parent that explicitly selected Default", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:dashboard:parent:thread:child",
        sessionStore: {
          "agent:main:dashboard:parent": {
            sessionId: "parent-session",
            updatedAt: 1,
            modelOverrideSource: "default",
            providerOverride: "anthropic",
            modelOverride: "stale-model",
          },
        },
      }),
    ).toBeNull();
  });

  it("does not inherit a parent pin after the child explicitly selects default", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "child-session",
          updatedAt: 2,
          modelOverrideSource: "default",
          providerOverride: "google-vertex",
          modelOverride: "stale-model",
        },
        sessionKey: "agent:main:dashboard:child",
        parentSessionKey: "agent:main:dashboard:parent",
        sessionStore: {
          "agent:main:dashboard:parent": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-6",
            modelOverrideSource: "user",
          },
        },
      }),
    ).toBeNull();
  });
});

it("preserves a pre-source selected model and its stored entry through the public view", () => {
  const entry = {
    sessionId: "legacy-selected",
    updatedAt: 1,
    providerOverride: "custom",
    modelOverride: "middle",
  };
  const result = resolveStoredModelOverride({
    sessionEntry: entry,
    defaultProvider: "openai",
  });
  expect(result).toEqual({
    provider: "custom",
    model: "middle",
    source: "session",
    routeResolution: "resolved",
  });
  expect(entry).toEqual({
    sessionId: "legacy-selected",
    updatedAt: 1,
    providerOverride: "custom",
    modelOverride: "middle",
  });
});

it("preserves normalized provider-less compatibility input through the public view", () => {
  expect(
    resolveStoredModelOverride({
      sessionEntry: { sessionId: "public-compat", updatedAt: 1, modelOverride: "openrouter:auto" },
      defaultProvider: "openai",
    }),
  ).toEqual({
    provider: "openrouter",
    model: "openrouter/auto",
    source: "session",
    routeResolution: "resolved",
  });
});
