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
  it("heads both groups with the design's label", () => {
    const { root } = setup();
    const heads = [...root.querySelectorAll("h3")];
    expect(heads.map((h) => h.textContent)).toEqual(["Note splits", "Expression"]);
    expect(heads.every((h) => h.classList.contains("ds-label"))).toBe(true);
  });

  it("'off' is a chip of its own, outside the slider's label, so a click on the word turns it off", () => {
    const { root, store } = setup();
    const chip = root.querySelector<HTMLLabelElement>("label.ds-chip")!;
    expect(chip.textContent).toBe("off");
    expect(chip.parentElement!.closest("label")).toBeNull();
    document.body.append(root);                       // a label passes its click on only in a document
    chip.querySelector("span")!.click();
    expect(store.get().onset_delta).toBeNull();
    root.remove();
  });

  it("Legato, Reset and Copy as flags are the design's buttons", () => {
    const { root } = setup();
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Legato", "Reset", "Copy as flags"]);
    expect(buttons.every((b) => b.classList.contains("ds-button"))).toBe(true);
  });

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

  it("every slider is the design system's quiet line", () => {
    const { root } = setup();
    const ranges = [...root.querySelectorAll<HTMLInputElement>('input[type="range"]')];
    expect(ranges.length).toBe(9);
    expect(ranges.every((r) => r.classList.contains("range-line"))).toBe(true);
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
