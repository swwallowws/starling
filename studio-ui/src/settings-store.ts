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

const KEY = "voxmpe.settings";

/** Keys that may be null ("none" / "off"), and the type they hold otherwise. */
const NULLABLE: Partial<Record<keyof Settings, "string" | "number">> = {
  tuning_name: "string",
  tuning_scl: "string",
  single_channel: "number",
  onset_delta: "number",
};

/** Whether a remembered `value` may stand in for setting `key`. */
function fits(key: keyof Settings, value: unknown, defaults: Settings): boolean {
  const nullable = NULLABLE[key];
  if (nullable) return value === null || typeof value === nullable;
  return typeof value === typeof defaults[key];
}

/** The remembered settings over `defaults`; unknown or ill-typed keys keep the default. */
export function loadSettings(storage: Storage, defaults: Settings): Settings {
  try {
    const saved: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (!saved || typeof saved !== "object") return { ...defaults };
    const out: Record<string, unknown> = { ...defaults };
    for (const [k, v] of Object.entries(saved)) {
      if (k in defaults && fits(k as keyof Settings, v, defaults)) out[k] = v;
    }
    return out as unknown as Settings;
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(storage: Storage, s: Settings) {
  try {
    storage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private window or blocked storage: settings just aren't remembered
  }
}
