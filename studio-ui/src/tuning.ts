import type { SettingsStore } from "./settings-store";
import type { Settings } from "./types";

/** A tuning: `name` is a built-in id (e.g. "53-edo") or a file name. */
export interface Scale { name: string; scl: string; }
/** What the picker shows: the active tuning (null = 12-TET), the last loaded
 *  file (offered again in the list), and an error to keep on screen. */
export interface TuningView { active: Scale | null; custom: Scale | null; error: string | null; }

/** Tuning picker state: a choice becomes active only after it renders; a bad
 *  file shows its error until the user chooses again. */
export function createTuning(store: SettingsStore, onView: (v: TuningView) => void) {
  let view: TuningView = { active: null, custom: null, error: null };
  let pending: { scale: Scale; file: boolean } | null = null;
  const show = (next: Partial<TuningView>) => { view = { ...view, ...next }; onView(view); };
  const apply = (sc: Scale | null) =>
    store.patch({ tuning_name: sc?.name ?? null, tuning_scl: sc?.scl ?? null });
  const pick = (sc: Scale | null, file: boolean) => {
    if (sc === null) {
      pending = null;
      apply(null);
      show({ active: null, error: null });
      return;
    }
    pending = { scale: sc, file };
    apply(sc);
    if (view.error) show({ error: null });
  };

  return {
    /** A built-in tuning, or null for 12-TET. */
    choose: (sc: Scale | null) => pick(sc, false),
    /** A `.scl` the user loaded. */
    loadFile: (sc: Scale) => pick(sc, true),
    /** The last loaded file, again. */
    chooseCustom() {
      if (view.custom) pick(view.custom, true);
    },
    renderOk(s: Settings) {
      if (!pending || s.tuning_scl !== pending.scale.scl) return;
      const { scale, file } = pending;
      pending = null;
      show({ active: scale, custom: file ? scale : view.custom, error: null });
    },
    renderError(msg: string) {
      pending = null;
      apply(view.active);
      show({ error: msg });
    },
  };
}
