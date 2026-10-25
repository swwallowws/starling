import { describe, expect, it } from "vitest";
import { settingsOnOpen } from "./take-settings";
import { DEFAULT_SETTINGS } from "./types";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const mine = { ...DEFAULT_SETTINGS, hold_ms: 150, smoothing: 0.2, tuning_name: "53-edo" };

describe("the starling's song's own settings", () => {
  it("the song opens with its settings: longer gaps, finer splits, no loudness splits, half smoothing", () => {
    const patch = settingsOnOpen(memory(), mine, true)!;
    expect(patch).toMatchObject({ gap_ms: 235, split_cents: 65, onset_delta: null, smoothing: 0.5, hold_ms: 90, jump_hold_ms: 90, jump_cents: 300, correction: 0, vibrato: 1 });
    expect(patch).not.toHaveProperty("tuning_name");          // the tuning is the take's own business
  });

  it("your next take gets your settings back, once", () => {
    const s = memory();
    settingsOnOpen(s, mine, true);
    expect(settingsOnOpen(s, { ...DEFAULT_SETTINGS, ...settingsOnOpen(memory(), mine, true)! }, false)).toMatchObject({ hold_ms: 150, smoothing: 0.2 });
    expect(settingsOnOpen(s, mine, false)).toBeNull();      // brought back already: nothing more to do
  });

  it("opening the song twice keeps yours, not the song's", () => {
    const s = memory();
    settingsOnOpen(s, mine, true);
    settingsOnOpen(s, { ...mine, gap_ms: 235, smoothing: 0.5 }, true);
    expect(settingsOnOpen(s, mine, false)).toMatchObject({ gap_ms: 80, smoothing: 0.2 });
  });

  it("your takes alone change nothing", () => {
    expect(settingsOnOpen(memory(), mine, false)).toBeNull();
  });
});
