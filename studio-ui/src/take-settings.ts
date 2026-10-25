// The starling's song opens with its own settings (SAMPLE_SETTINGS); your takes keep yours.
// Opening the song puts your settings aside, opening one of your takes after it brings them
// back. Kept in this browser, so a reload between the two still brings them back.
import { DEFAULT_SETTINGS, type Settings } from "./types";
import { SAMPLE_SETTINGS } from "./try/sample";

const KEY = "voxmpe:settings-before-sample";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The settings the song's own values replace: the ones put aside and brought back. */
const OWNED = ["hold_ms", "jump_hold_ms", "jump_cents", "gap_ms", "split_cents", "onset_delta", "smoothing", "correction", "vibrato"] as const;
type Owned = Pick<Settings, (typeof OWNED)[number]>;
const pick = (s: Settings): Owned => Object.fromEntries(OWNED.map((k) => [k, s[k]])) as Owned;

/** What to change as a take opens: the song's settings for the song (yours put aside, once),
 *  yours back for any other take after it. `null`: nothing changes. */
export function settingsOnOpen(storage: Store, current: Settings, sample: boolean): Partial<Settings> | null {
  const aside = storage.getItem(KEY);
  if (sample) {
    if (aside === null) {
      try { storage.setItem(KEY, JSON.stringify(pick(current))); } catch { /* no storage: yours aren't kept */ }
    }
    return { ...pick(DEFAULT_SETTINGS), ...SAMPLE_SETTINGS };
  }
  if (aside === null) return null;
  try { storage.removeItem(KEY); } catch { /* it would just be read again */ }
  try { return JSON.parse(aside) as Owned; } catch { return null; }
}
