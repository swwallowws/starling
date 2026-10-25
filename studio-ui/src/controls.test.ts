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

  it("built with re-attack off (the starling's song after a reload), turning it on gives the default, not a stray value", () => {
    const root = document.createElement("div");
    const store = createSettingsStore({ ...DEFAULT_SETTINGS, onset_delta: null });
    buildControls(root, store);
    const range = root.querySelector<HTMLInputElement>(".onset input[type=range]")!;
    expect(range.value).toBe(String(DEFAULT_SETTINGS.onset_delta));
    expect(root.querySelector(".onset .val")!.textContent).toBe("+60%");
    document.body.append(root);
    root.querySelector<HTMLElement>(".onset .ds-check span")!.click();
    expect(store.get().onset_delta).toBe(DEFAULT_SETTINGS.onset_delta);
    root.remove();
  });

  it("a fill square before Loudness re-attack turns the whole item off and on, keeping its value", () => {
    const { root, store } = setup();
    const onset = root.querySelector<HTMLElement>(".onset")!;
    const check = onset.querySelector<HTMLLabelElement>("label.ds-check")!;
    expect(onset.firstElementChild).toBe(check);
    expect(check.textContent).toBe("");                 // no "off": the square says it
    const before = store.get().onset_delta;
    document.body.append(root);                       // a label passes its click on only in a document
    check.querySelector("span")!.click();
    expect(store.get().onset_delta).toBeNull();
    expect(onset.classList.contains("off")).toBe(true);
    check.querySelector("span")!.click();
    expect(store.get().onset_delta).toBe(before);
    expect(onset.classList.contains("off")).toBe(false);
    root.remove();
  });

  it("the panel starts with one choice, Default or Legato, lit while the settings are that preset", () => {
    const { root, store } = setup();
    const [def, legato] = [...root.querySelectorAll<HTMLButtonElement>(".presets .ds-choice button")];
    expect([def.textContent, legato.textContent]).toEqual(["Default", "Legato"]);
    expect(def.classList.contains("on") && !legato.classList.contains("on")).toBe(true);
    legato.click();
    expect(!def.classList.contains("on") && legato.classList.contains("on")).toBe(true);
    store.patch({ hold_ms: 222 });
    expect(def.classList.contains("on") || legato.classList.contains("on")).toBe(false);
  });

  it("moving a slider keeps a tuning loaded elsewhere", () => {
    const { root, store } = setup();
    const hold = root.querySelector<HTMLInputElement>('input[type="range"]')!;
    hold.value = "150";
    hold.dispatchEvent(new Event("input"));
    expect(store.get()).toMatchObject({ hold_ms: 150, tuning_scl: "! 31", anchor_hz: 440 });
  });

  it("Legato and Default keep the tuning and anchor", () => {
    const { root, store } = setup();
    const [reset, legato] = [...root.querySelectorAll(".presets button")] as HTMLButtonElement[];
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

  it("Default also resets expression, Legato leaves it", () => {
    const { root, store } = setup();
    store.patch({ correction: 0.7 });
    const [reset, legato] = [...root.querySelectorAll(".presets button")] as HTMLButtonElement[];
    legato.click();
    expect(store.get().correction).toBeCloseTo(0.7);
    reset.click();
    expect(store.get().correction).toBe(0);
  });
});
