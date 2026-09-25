import { describe, expect, it, vi } from "vitest";
import { createSettingsStore } from "./settings-store";
import { createTuning, type TuningView } from "./tuning";
import { DEFAULT_SETTINGS } from "./types";

const makam = { name: "53-edo", scl: "makam" };
const file = { name: "31edo.scl", scl: "good" };
const bad = { name: "broken.scl", scl: "bad" };

function setup() {
  const store = createSettingsStore(DEFAULT_SETTINGS);
  const views: TuningView[] = [];
  const t = createTuning(store, (v) => views.push(v));
  const last = () => views[views.length - 1];
  return { store, t, last };
}

describe("tuning picker state", () => {
  it("a built-in tuning becomes active only after it renders", () => {
    const { store, t, last } = setup();
    t.choose(makam);
    expect(store.get()).toMatchObject({ tuning_name: "53-edo", tuning_scl: "makam" });
    expect(last()?.active ?? null).toBeNull();
    t.renderOk(store.get());
    expect(last()).toEqual({ active: makam, custom: null, error: null });
  });

  it("a loaded file becomes active and is remembered as the custom scale", () => {
    const { store, t, last } = setup();
    t.loadFile(file);
    t.renderOk(store.get());
    expect(last()).toEqual({ active: file, custom: file, error: null });
  });

  it("starts from a remembered tuning, which a bad file then falls back to", () => {
    const store = createSettingsStore({ ...DEFAULT_SETTINGS, tuning_name: "31edo.scl", tuning_scl: "good" });
    const t = createTuning(store, () => {});
    expect(t.view()).toEqual({ active: file, custom: file, error: null });
    t.loadFile(bad);
    t.renderError("tuning: bad note count");
    expect(store.get()).toMatchObject({ tuning_name: "31edo.scl", tuning_scl: "good" });
  });

  it("starts at 12-TET when nothing is remembered", () => {
    expect(setup().t.view()).toEqual({ active: null, custom: null, error: null });
  });

  it("a bad file shows its error, reverts, and the error survives the retry render", () => {
    const { store, t, last } = setup();
    t.choose(makam);
    t.renderOk(store.get());
    t.loadFile(bad);
    t.renderError("tuning: bad note count");
    expect(store.get().tuning_scl).toBe("makam");
    expect(last()).toEqual({ active: makam, custom: null, error: "tuning: bad note count" });
    t.renderOk(store.get());
    expect(last().error).toBe("tuning: bad note count");
  });

  it("switching away and back restores the loaded file", () => {
    const { store, t } = setup();
    t.loadFile(file);
    t.renderOk(store.get());
    t.choose(null);
    expect(store.get().tuning_scl).toBeNull();
    t.chooseCustom();
    expect(store.get()).toMatchObject({ tuning_name: "31edo.scl", tuning_scl: "good" });
  });

  it("choosing a tuning clears an old error", () => {
    const { store, t, last } = setup();
    t.loadFile(bad);
    t.renderError("tuning: bad");
    expect(last().error).toBe("tuning: bad");
    t.choose(null);
    expect(last().error).toBeNull();
    expect(store.get().tuning_scl).toBeNull();
  });

  it("ignores render results unrelated to a pending choice", () => {
    const onView = vi.fn();
    const store = createSettingsStore(DEFAULT_SETTINGS);
    const t = createTuning(store, onView);
    t.renderOk(store.get());
    expect(onView).not.toHaveBeenCalled();
  });
});
