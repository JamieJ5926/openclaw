import { describe, expect, it } from "vitest";
import type { ProviderAuthChoiceMetadata } from "./provider-auth-choices.js";
import {
  isProviderLoginChoiceStartable,
  listProviderAccessOptions,
  listProviderLoginOptions,
} from "./provider-login-options.js";

function choice(overrides: Partial<ProviderAuthChoiceMetadata> = {}): ProviderAuthChoiceMetadata {
  return {
    pluginId: "provider-owner",
    providerId: "fixture",
    methodId: "device",
    choiceId: "fixture-device",
    choiceLabel: "Fixture sign-in",
    appGuidedAuth: "device-code",
    ...overrides,
  };
}

describe("provider sign-in choices", () => {
  it("does not expose an ambiguous owner id, while preserving an independent choice", () => {
    const options = listProviderLoginOptions([
      choice(),
      choice({ pluginId: "other-owner" }),
      choice({ choiceId: "independent", choiceLabel: "Independent" }),
    ]);
    expect(options.map((option) => option.id)).toEqual(["independent"]);
  });

  it("keeps manual-only and media-only declarations out of executable sign-in", () => {
    const options = listProviderLoginOptions([
      choice({ assistantVisibility: "manual-only" }),
      choice({ choiceId: "media", onboardingScopes: ["image-generation"] }),
      choice({ choiceId: "valid", onboardingScopes: ["text-inference"] }),
    ]);
    expect(options.map((option) => option.id)).toEqual(["valid"]);
  });

  it("distinguishes a declared setup action from credential-only sign-in", () => {
    const setup = choice({
      choiceId: "discover",
      appGuidedAuth: undefined,
      appGuidedDiscovery: true,
    });
    expect(isProviderLoginChoiceStartable(setup)).toBe(false);
    expect(listProviderAccessOptions([setup])).toMatchObject([
      { id: "discover", kind: "setup", mode: "setup" },
    ]);
    expect(listProviderAccessOptions([choice()])).toMatchObject([
      { id: "fixture-device", kind: "device-code", mode: "login" },
    ]);
  });
});
