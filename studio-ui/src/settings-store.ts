import type { Settings } from "./types";

/** The single owner of the studio's settings: every control sends a patch. */
export interface SettingsStore {
  get(): Settings;
  patch(p: Partial<Settings>): void;
  subscribe(f: (s: Settings) => void): void;
}

export function createSettingsStore(initial: Settings): SettingsStore {
  let s = { ...initial };
  const subs: ((s: Settings) => void)[] = [];
  return {
    get: () => s,
    patch(p) {
      s = { ...s, ...p };
      for (const f of subs) f(s);
    },
    subscribe(f) {
      subs.push(f);
    },
  };
}
