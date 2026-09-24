import type { SettingsStore } from "./settings-store";
import type { Settings } from "./types";

export interface Scale { name: string; scl: string; }
/** What the tuning picker shows. `loaded` is the last scale that rendered. */
export interface TuningView { choice: "12tet" | "loaded"; loaded: Scale | null; error: string | null; }

/** Tuning picker state: a file becomes the loaded scale only after it renders;
 *  a bad file shows its error until the user chooses again. */
export function createTuning(store: SettingsStore, onView: (v: TuningView) => void) {
  let view: TuningView = { choice: "12tet", loaded: null, error: null };
  let pending: Scale | null = null;
  const show = (next: Partial<TuningView>) => { view = { ...view, ...next }; onView(view); };
  const apply = (sc: Scale | null) =>
    store.patch({ tuning_name: sc?.name ?? null, tuning_scl: sc?.scl ?? null });

  return {
    loadFile(sc: Scale) {
      pending = sc;
      apply(sc);
    },
    renderOk(s: Settings) {
      if (!pending || s.tuning_scl !== pending.scl) return;
      const sc = pending;
      pending = null;
      show({ choice: "loaded", loaded: sc, error: null });
    },
    renderError(msg: string) {
      pending = null;
      apply(view.choice === "loaded" ? view.loaded : null);
      show({ error: msg });
    },
    choose12() {
      pending = null;
      apply(null);
      show({ choice: "12tet", error: null });
    },
    chooseLoaded() {
      if (!view.loaded) return;
      pending = null;
      apply(view.loaded);
      show({ choice: "loaded", error: null });
    },
  };
}
