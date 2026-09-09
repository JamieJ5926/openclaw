import { compareProviderAuthChoiceGroups } from "./provider-auth-choice-order.js";
import type { ProviderAuthChoiceMetadata } from "./provider-auth-choices.js";

export type ProviderLoginOption = {
  id: string;
  brandId?: string;
  label: string;
  hint?: string;
  groupLabel?: string;
  icon?: string;
  website?: string;
  kind: "oauth" | "device-code" | "secret";
  featured: boolean;
};

export type ProviderAccessOption = Omit<ProviderLoginOption, "kind"> & {
  actionLabel?: string;
  kind: ProviderLoginOption["kind"] | "setup";
  mode: "login" | "setup";
};

export function supportsProviderAuthChoiceTextInference(
  scopes?: ProviderAuthChoiceMetadata["onboardingScopes"],
): boolean {
  return !scopes || scopes.includes("text-inference");
}

function isProviderLoginSurfaceEligible(choice: ProviderAuthChoiceMetadata): boolean {
  return (
    choice.choiceId.trim().length > 0 &&
    supportsProviderAuthChoiceTextInference(choice.onboardingScopes) &&
    choice.assistantVisibility !== "manual-only"
  );
}

function projectSharedOptionFields(choice: ProviderAuthChoiceMetadata) {
  return {
    id: choice.choiceId.trim(),
    brandId: choice.providerId,
    label: choice.choiceLabel,
    ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
    ...(choice.icon ? { icon: choice.icon } : {}),
    ...(choice.website ? { website: choice.website } : {}),
    featured: choice.onboardingFeatured === true,
  };
}

function toProviderLoginOption(
  choice: ProviderAuthChoiceMetadata,
): ProviderLoginOption | undefined {
  const kind =
    choice.appGuidedAuth ??
    (choice.appGuidedSecret === true && choice.appGuidedDiscovery !== true ? "secret" : undefined);
  return isProviderLoginSurfaceEligible(choice) && kind
    ? { ...projectSharedOptionFields(choice), kind }
    : undefined;
}

function toProviderAccessOption(
  choice: ProviderAuthChoiceMetadata,
): ProviderAccessOption | undefined {
  if (!isProviderLoginSurfaceEligible(choice)) {
    return undefined;
  }
  const login = toProviderLoginOption(choice);
  return login
    ? { ...login, mode: "login" }
    : {
        ...projectSharedOptionFields(choice),
        ...(choice.appGuidedActionLabel?.trim()
          ? { actionLabel: choice.appGuidedActionLabel.trim() }
          : {}),
        kind: "setup",
        mode: "setup",
      };
}

/** Whether the Gateway can start this choice as a credential-only provider login. */
export function isProviderLoginChoiceStartable(choice: ProviderAuthChoiceMetadata): boolean {
  return toProviderLoginOption(choice) !== undefined;
}

/** Featured first, then provider family, manifest assistant priority, label, id. */
function compareProviderLoginSurface(
  a: ProviderAuthChoiceMetadata,
  b: ProviderAuthChoiceMetadata,
): number {
  return (
    Number(b.onboardingFeatured === true) - Number(a.onboardingFeatured === true) ||
    compareProviderAuthChoiceGroups(
      { id: a.groupId ?? a.providerId, label: a.groupLabel ?? a.choiceLabel },
      { id: b.groupId ?? b.providerId, label: b.groupLabel ?? b.choiceLabel },
    ) ||
    (a.assistantPriority ?? 0) - (b.assistantPriority ?? 0) ||
    a.choiceLabel.localeCompare(b.choiceLabel, "en") ||
    a.choiceId.trim().localeCompare(b.choiceId.trim(), "en")
  );
}

/**
 * Choice ids claimed by more than one owner are dropped entirely: a click on an
 * ambiguous id could otherwise start the wrong plugin's credential flow.
 */
function listRankedOptions<T>(
  authChoices: readonly ProviderAuthChoiceMetadata[],
  project: (choice: ProviderAuthChoiceMetadata) => T | undefined,
): T[] {
  const choiceIdCounts = new Map<string, number>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (id) {
      choiceIdCounts.set(id, (choiceIdCounts.get(id) ?? 0) + 1);
    }
  }
  return authChoices
    .filter((choice) => choiceIdCounts.get(choice.choiceId.trim()) === 1)
    .toSorted(compareProviderLoginSurface)
    .flatMap((choice) => {
      const option = project(choice);
      return option ? [option] : [];
    });
}

export function listProviderLoginOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): ProviderLoginOption[] {
  return listRankedOptions(authChoices, toProviderLoginOption);
}

export function listProviderAccessOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): ProviderAccessOption[] {
  return listRankedOptions(authChoices, toProviderAccessOption);
}
