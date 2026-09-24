import { describe, expect, it, vi } from "vitest";
import { createSettingsStore } from "./settings-store";
import { DEFAULT_SETTINGS } from "./types";

describe("settings store", () => {
  it("merges patches and notifies subscribers", () => {
    const store = createSettingsStore(DEFAULT_SETTINGS);
    const seen = vi.fn();
    store.subscribe(seen);
    store.patch({ tuning_name: "31edo.scl", tuning_scl: "x" });
    store.patch({ hold_ms: 150 });
    expect(store.get()).toMatchObject({ tuning_name: "31edo.scl", tuning_scl: "x", hold_ms: 150 });
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
