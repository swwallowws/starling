import { describe, expect, it, vi } from "vitest";
import { createSettingsStore } from "./settings-store";
import { createTuning, type TuningView } from "./tuning";
import { DEFAULT_SETTINGS } from "./types";

const good = { name: "31edo.scl", scl: "good" };
const bad = { name: "broken.scl", scl: "bad" };

function setup() {
  const store = createSettingsStore(DEFAULT_SETTINGS);
  const views: TuningView[] = [];
  const t = createTuning(store, (v) => views.push(v));
  const last = () => views[views.length - 1];
  return { store, t, last };
}

describe("tuning picker state", () => {
  it("a scale becomes the loaded choice only after it renders", () => {
    const { store, t, last } = setup();
    t.loadFile(good);
    expect(store.get().tuning_scl).toBe("good");
    expect(last()?.loaded ?? null).toBeNull();
    t.renderOk(store.get());
    expect(last()).toEqual({ choice: "loaded", loaded: good, error: null });
  });

  it("a bad file shows its error, reverts, and the error survives the retry render", () => {
    const { store, t, last } = setup();
    t.loadFile(good);
    t.renderOk(store.get());
    t.loadFile(bad);
    t.renderError("tuning: bad note count");
    expect(store.get().tuning_scl).toBe("good");
    expect(last()).toEqual({ choice: "loaded", loaded: good, error: "tuning: bad note count" });
    t.renderOk(store.get()); // the fallback render succeeds
    expect(last().error).toBe("tuning: bad note count");
  });

  it("switching to 12-TET and back restores the loaded scale", () => {
    const { store, t } = setup();
    t.loadFile(good);
    t.renderOk(store.get());
    t.choose12();
    expect(store.get().tuning_scl).toBeNull();
    t.chooseLoaded();
    expect(store.get()).toMatchObject({ tuning_name: "31edo.scl", tuning_scl: "good" });
  });

  it("choosing a tuning clears an old error", () => {
    const { store, t, last } = setup();
    t.loadFile(bad);
    t.renderError("tuning: bad");
    expect(last().error).toBe("tuning: bad");
    t.choose12();
    expect(last().error).toBeNull();
    expect(store.get().tuning_scl).toBeNull();
  });

  it("ignores render results unrelated to a pending file", () => {
    const onView = vi.fn();
    const store = createSettingsStore(DEFAULT_SETTINGS);
    const t = createTuning(store, onView);
    t.renderOk(store.get());
    expect(onView).not.toHaveBeenCalled();
  });
});
