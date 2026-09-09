import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const hoisted = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(),
}));

vi.mock("./credential-normalize.js", () => ({
  normalizeAuthProfileCredential: (credential: unknown) => credential,
}));
vi.mock("./store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: hoisted.updateAuthProfileStoreWithLock,
}));

import { upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

describe("upsertAuthProfileWithLockOrThrow", () => {
  beforeEach(() => {
    hoisted.updateAuthProfileStoreWithLock.mockReset();
  });

  it("resolves after the locked store update succeeds", async () => {
    hoisted.updateAuthProfileStoreWithLock.mockResolvedValue({ version: 1, profiles: {} });

    await expect(
      upsertAuthProfileWithLockOrThrow({
        profileId: "test:default",
        credential: { type: "token", provider: "test", token: "secret" },
      }),
    ).resolves.toBeUndefined();
  });

  it("validates the current profile before the locked writer changes it", async () => {
    const original = { type: "token", provider: "sample", token: "kept-token" } as const;
    const store: AuthProfileStore = { version: 1, profiles: { "sample:manual-api-key": original } };
    hoisted.updateAuthProfileStoreWithLock.mockImplementation(
      async ({ updater }: { updater: (store: AuthProfileStore) => boolean }) => {
        updater(store);
        return store;
      },
    );
    await expect(
      upsertAuthProfileWithLockOrThrow({
        profileId: "sample:manual-api-key",
        credential: { type: "api_key", provider: "sample", key: "new-key" },
        validateCurrentCredential: (current) => {
          if (current?.type !== "api_key") {
            throw new Error("Profile kind changed");
          }
        },
      }),
    ).rejects.toThrow("Profile kind changed");
    expect(store.profiles["sample:manual-api-key"]).toEqual(original);
  });

  it("fails with the canonical retry guidance when the locked update fails", async () => {
    hoisted.updateAuthProfileStoreWithLock.mockResolvedValue(null);

    await expect(
      upsertAuthProfileWithLockOrThrow({
        profileId: "test:default",
        credential: { type: "token", provider: "test", token: "secret" },
      }),
    ).rejects.toThrow(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  });
});
