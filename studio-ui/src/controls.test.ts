// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildControls } from "./controls";
import { createSettingsStore } from "./settings-store";
import { DEFAULT_SETTINGS } from "./types";

const loaded = { ...DEFAULT_SETTINGS, tuning_name: "31edo.scl", tuning_scl: "! 31", anchor_hz: 440 };

function setup() {
  const root = document.createElement("div");
  const store = createSettingsStore(DEFAULT_SETTINGS);
  buildControls(root, store);
  // The tuning and anchor arrive from outside the controls, after they were built.
  store.patch({ tuning_name: loaded.tuning_name, tuning_scl: loaded.tuning_scl, anchor_hz: 440 });
  return { root, store };
}

describe("controls", () => {
  it("moving a slider keeps a tuning loaded elsewhere", () => {
    const { root, store } = setup();
    const hold = root.querySelector<HTMLInputElement>('input[type="range"]')!;
    hold.value = "150";
    hold.dispatchEvent(new Event("input"));
    expect(store.get()).toMatchObject({ hold_ms: 150, tuning_scl: "! 31", anchor_hz: 440 });
  });

  it("Legato and Reset keep the tuning and anchor", () => {
    const { root, store } = setup();
    const [legato, reset] = [...root.querySelectorAll("button")];
    legato.click();
    expect(store.get()).toMatchObject({ hold_ms: 180, gap_ms: 150, onset_delta: null, tuning_scl: "! 31", anchor_hz: 440 });
    reset.click();
    expect(store.get()).toMatchObject({ hold_ms: 90, tuning_scl: "! 31", anchor_hz: 440 });
  });

  it("sliders follow changes made elsewhere", () => {
    const { root, store } = setup();
    store.patch({ hold_ms: 200 });
    expect(root.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("200");
  });
  it("expression sliders patch the store as fractions", () => {
    const { root, store } = setup();
    const smoothing = root.querySelector<HTMLInputElement>('input[name="smoothing"]')!;
    smoothing.value = "40";
    smoothing.dispatchEvent(new Event("input"));
    expect(store.get().smoothing).toBeCloseTo(0.4);
    const vibrato = root.querySelector<HTMLInputElement>('input[name="vibrato"]')!;
    expect(vibrato.value).toBe("100");
  });

  it("Reset also resets expression, Legato leaves it", () => {
    const { root, store } = setup();
    store.patch({ correction: 0.7 });
    const [legato, reset] = [...root.querySelectorAll("button")];
    legato.click();
    expect(store.get().correction).toBeCloseTo(0.7);
    reset.click();
    expect(store.get().correction).toBe(0);
  });
});
