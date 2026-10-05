import type { SettingsStore } from "./settings-store";
import { DEFAULT_SETTINGS, LEGATO, type Settings } from "./types";

type NumKey = "hold_ms" | "jump_hold_ms" | "jump_cents" | "gap_ms" | "split_cents";
const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "hold_ms", label: "New note after (small step)", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "jump_hold_ms", label: "New note after (big leap)", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "jump_cents", label: "Big leap from", min: 100, max: 1200, step: 10, unit: "cents" },
  { key: "gap_ms", label: "Gap that splits", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "split_cents", label: "Pitch move that splits", min: 30, max: 300, step: 5, unit: "cents" },
];

type PctKey = "smoothing" | "correction" | "vibrato";
/** Expression sliders show percent; the store holds fractions (vibrato 1 = as sung). */
const EXPRESSION: { key: PctKey; label: string; max: number }[] = [
  { key: "smoothing", label: "Smoothing", max: 100 },
  { key: "correction", label: "Correction (pull onto the note)", max: 100 },
  { key: "vibrato", label: "Vibrato", max: 150 },
];

const expression = (s: Partial<Settings>): Partial<Settings> => ({
  smoothing: s.smoothing,
  correction: s.correction,
  vibrato: s.vibrato,
});

/** The segmentation settings these controls own; tuning and anchor belong to the tuning picker. */
const segmentation = (s: Partial<Settings>): Partial<Settings> => ({
  hold_ms: s.hold_ms,
  jump_hold_ms: s.jump_hold_ms,
  jump_cents: s.jump_cents,
  gap_ms: s.gap_ms,
  split_cents: s.split_cents,
  onset_delta: s.onset_delta,
});

/** Sliders, onset, Legato/Reset and the flags line. Every change is a patch to
 *  `store`, so settings changed elsewhere (tuning, anchor) are never overwritten. */
export function buildControls(root: HTMLElement, store: SettingsStore) {
  root.innerHTML = "";
  const inputs = new Map<NumKey, [HTMLInputElement, HTMLElement]>();
  root.append(Object.assign(document.createElement("h3"), { textContent: "Note splits" }));

  for (const d of SLIDERS) {
    const label = document.createElement("label");
    const val = document.createElement("span");
    const input = Object.assign(document.createElement("input"), { type: "range", className: "range-line", min: String(d.min), max: String(d.max), step: String(d.step) });
    input.addEventListener("input", () => store.patch({ [d.key]: Number(input.value) }));
    label.append(d.label, val, input);
    root.append(label);
    inputs.set(d.key, [input, val]);
  }

  const onset = document.createElement("label");
  const onsetVal = document.createElement("span");
  const onsetRange = Object.assign(document.createElement("input"), { type: "range", className: "range-line", min: "0.1", max: "3", step: "0.05" });
  const onsetOff = Object.assign(document.createElement("input"), { type: "checkbox" });
  onsetRange.addEventListener("input", () => store.patch({ onset_delta: Number(onsetRange.value) }));
  onsetOff.addEventListener("change", () => store.patch({ onset_delta: onsetOff.checked ? null : Number(onsetRange.value) }));
  // Plain ink: the accent is for current values, and "off" is a choice, not a value.
  const offLabel = Object.assign(document.createElement("span"), { className: "plain" });
  offLabel.append(onsetOff, " off");
  onset.append("Loudness re-attack", onsetVal, onsetRange, offLabel);
  root.append(onset);

  const exprHead = Object.assign(document.createElement("h3"), { textContent: "Expression" });
  root.append(exprHead);
  const pcts = new Map<PctKey, [HTMLInputElement, HTMLElement]>();
  for (const d of EXPRESSION) {
    const label = document.createElement("label");
    const val = document.createElement("span");
    const input = Object.assign(document.createElement("input"), { type: "range", className: "range-line", name: d.key, min: "0", max: String(d.max), step: "5" });
    input.addEventListener("input", () => store.patch({ [d.key]: Number(input.value) / 100 }));
    label.append(d.label, val, input);
    root.append(label);
    pcts.set(d.key, [input, val]);
  }

  const buttons = document.createElement("div");
  const legato = Object.assign(document.createElement("button"), { textContent: "Legato" });
  const reset = Object.assign(document.createElement("button"), { textContent: "Reset" });
  legato.addEventListener("click", () => store.patch(segmentation({ ...DEFAULT_SETTINGS, ...LEGATO })));
  reset.addEventListener("click", () => store.patch({ ...segmentation(DEFAULT_SETTINGS), ...expression(DEFAULT_SETTINGS) }));
  buttons.append(legato, " ", reset);
  root.append(buttons);

  const flags = document.createElement("p");
  const code = document.createElement("code");
  const copy = Object.assign(document.createElement("button"), { textContent: "Copy as flags" });
  copy.addEventListener("click", () => navigator.clipboard.writeText(code.textContent ?? ""));
  flags.append(code, " ", copy);
  // The settings as command-line flags: for the desktop command line, which isn't public,
  // so the line is kept (tests and local use read it) but not shown.
  flags.hidden = true;
  root.append(flags);

  function sync(s: Settings) {
    for (const [key, [input, val]] of inputs) {
      const d = SLIDERS.find((x) => x.key === key)!;
      input.value = String(s[key]);
      input.style.setProperty("--fill", `${((s[key] - d.min) / (d.max - d.min)) * 100}%`);
      val.textContent = `${s[key]} ${d.unit}`;
    }
    onsetOff.checked = s.onset_delta === null;
    onsetRange.disabled = s.onset_delta === null;
    if (s.onset_delta !== null) onsetRange.value = String(s.onset_delta);
    onsetRange.style.setProperty("--fill", `${((Number(onsetRange.value) - 0.1) / (3 - 0.1)) * 100}%`);
    onsetVal.textContent = s.onset_delta === null ? "off" : `+${Math.round(s.onset_delta * 100)}%`;
    for (const [key, [input, val]] of pcts) {
      const d = EXPRESSION.find((x) => x.key === key)!;
      const pct = Math.round(s[key] * 100);
      input.value = String(pct);
      input.style.setProperty("--fill", `${(pct / d.max) * 100}%`);
      val.textContent = key === "vibrato" && pct === 100 ? "as sung" : `${pct}%`;
    }
  }
  sync(store.get());
  store.subscribe(sync);
  return {
    setFlags(text: string) { code.textContent = text || "(defaults)"; },
  };
}
