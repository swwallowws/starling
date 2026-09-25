import { describe, expect, it, vi } from "vitest";
import { createSettingsStore, loadSettings, saveSettings } from "./settings-store";
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

describe("settings memory", () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      get length() {
        return m.size;
      },
    };
  };

  it("remembers the last settings", () => {
    const s = memory();
    saveSettings(s, { ...DEFAULT_SETTINGS, hold_ms: 95, tuning_name: "31-edo", onset_delta: null });
    expect(loadSettings(s, DEFAULT_SETTINGS)).toEqual({ ...DEFAULT_SETTINGS, hold_ms: 95, tuning_name: "31-edo", onset_delta: null });
  });

  it("loadSettings keeps only known, well-typed keys", () => {
    const s = memory();
    s.setItem("voxmpe.settings", JSON.stringify({ hold_ms: "fast", gap_ms: 120, bogus: 1, tuning_scl: 5 }));
    expect(loadSettings(s, DEFAULT_SETTINGS)).toEqual({ ...DEFAULT_SETTINGS, gap_ms: 120 });
    s.setItem("voxmpe.settings", "{");
    expect(loadSettings(s, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("works without storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(loadSettings(broken, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(broken, DEFAULT_SETTINGS)).not.toThrow();
  });
});
