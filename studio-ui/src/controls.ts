import type { SettingsStore } from "./settings-store";
import { DEFAULT_SETTINGS, LEGATO, type Settings } from "./types";

type NumKey = "hold_ms" | "jump_hold_ms" | "jump_cents" | "gap_ms" | "split_cents";
const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "hold_ms", label: "New note after (small step)", min: 30, max: 400, step: 5, unit: "ms" },
  // what counts as a big leap comes right before the setting it governs
  { key: "jump_cents", label: "Big leap from", min: 100, max: 1200, step: 10, unit: "cents" },
  { key: "jump_hold_ms", label: "New note after (big leap)", min: 30, max: 400, step: 5, unit: "ms" },
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

/** Sliders, onset, the Default/Legato choice and the flags line. Every change is a patch to
 *  `store`, so settings changed elsewhere (tuning, anchor) are never overwritten. */
export function buildControls(root: HTMLElement, store: SettingsStore) {
  root.innerHTML = "";
  const inputs = new Map<NumKey, [HTMLInputElement, HTMLElement]>();
  root.append(Object.assign(document.createElement("h3"), { className: "ds-label", textContent: "Note splits" }));

  for (const d of SLIDERS) {
    const label = document.createElement("label");
    const val = document.createElement("span");
    const input = Object.assign(document.createElement("input"), { type: "range", className: "range-line", min: String(d.min), max: String(d.max), step: String(d.step) });
    input.addEventListener("input", () => store.patch({ [d.key]: Number(input.value) }));
    label.append(d.label, val, input);
    root.append(label);
    inputs.set(d.key, [input, val]);
  }

  // Loudness re-attack: a fill square before its name turns the whole item on or off (as
  // Rearranged's checks do); off, the item dims and keeps its value for when it comes back.
  const onset = Object.assign(document.createElement("div"), { className: "onset" });
  const onsetVal = Object.assign(document.createElement("span"), { className: "val" });
  const onsetRange = Object.assign(document.createElement("input"), { type: "range", className: "range-line", min: "0.1", max: "3", step: "0.05" });
  onsetRange.setAttribute("aria-label", "Loudness re-attack");
  let lastOnset = DEFAULT_SETTINGS.onset_delta ?? 0.6;
  const onsetOn = Object.assign(document.createElement("input"), { type: "checkbox" });
  onsetOn.setAttribute("aria-label", "Loudness re-attack on");
  onsetRange.addEventListener("input", () => store.patch({ onset_delta: Number(onsetRange.value) }));
  onsetOn.addEventListener("change", () => store.patch({ onset_delta: onsetOn.checked ? Number(onsetRange.value) : null }));
  const onsetCheck = Object.assign(document.createElement("label"), { className: "ds-check" });
  onsetCheck.append(onsetOn, document.createElement("span"));
  onset.append(onsetCheck, Object.assign(document.createElement("span"), { className: "name", textContent: "Loudness re-attack" }), onsetVal, onsetRange);
  root.append(onset);

  const exprHead = Object.assign(document.createElement("h3"), { className: "ds-label", textContent: "Expression" });
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

  // The presets lead the panel, as one choice: Default puts every setting back, Legato
  // gives longer, joined notes. Lit while the settings are that preset; a moved slider
  // lights neither.
  const presets = Object.assign(document.createElement("div"), { className: "presets" });
  const choice = Object.assign(document.createElement("span"), { className: "ds-choice small" });
  choice.setAttribute("role", "group");
  choice.setAttribute("aria-label", "Preset");
  const preset = (text: string, onClick: () => void) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: text });
    b.addEventListener("click", onClick);
    choice.append(b);
    return b;
  };
  const defaultBtn = preset("Default", () => store.patch({ ...segmentation(DEFAULT_SETTINGS), ...expression(DEFAULT_SETTINGS) }));
  const legatoBtn = preset("Legato", () => store.patch(segmentation({ ...DEFAULT_SETTINGS, ...LEGATO })));
  presets.append(
    Object.assign(document.createElement("span"), { className: "ds-label", textContent: "Preset" }),
    choice,
    Object.assign(document.createElement("p"), { className: "fine", textContent: "Legato: longer, joined notes, fewer splits." }),
  );
  root.prepend(presets);
  const same = (a: Partial<Settings>, b: Partial<Settings>) => JSON.stringify(a) === JSON.stringify(b);

  const flags = document.createElement("p");
  const code = document.createElement("code");
  const copy = Object.assign(document.createElement("button"), { className: "ds-button small", textContent: "Copy as flags" });
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
    onsetOn.checked = s.onset_delta !== null;
    onsetRange.disabled = s.onset_delta === null;
    onset.classList.toggle("off", s.onset_delta === null);
    // off, the slider keeps the last value it had on (the default if it never was), so
    // turning it back on picks up where it was, never wherever the browser left the thumb
    if (s.onset_delta !== null) lastOnset = s.onset_delta;
    onsetRange.value = String(lastOnset);
    onsetRange.style.setProperty("--fill", `${((Number(onsetRange.value) - 0.1) / (3 - 0.1)) * 100}%`);
    onsetVal.textContent = `+${Math.round(Number(onsetRange.value) * 100)}%`;
    const seg = segmentation(s);
    defaultBtn.classList.toggle("on", same(seg, segmentation(DEFAULT_SETTINGS)) && same(expression(s), expression(DEFAULT_SETTINGS)));
    legatoBtn.classList.toggle("on", same(seg, segmentation({ ...DEFAULT_SETTINGS, ...LEGATO })));
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
