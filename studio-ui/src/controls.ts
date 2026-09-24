import { DEFAULT_SETTINGS, LEGATO, type Settings } from "./types";

type NumKey = "hold_ms" | "jump_hold_ms" | "jump_cents" | "gap_ms" | "split_cents";
const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "hold_ms", label: "Hold (small moves)", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "jump_hold_ms", label: "Hold (big jumps)", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "jump_cents", label: "Big jump from", min: 100, max: 1200, step: 10, unit: "c" },
  { key: "gap_ms", label: "Gap that splits", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "split_cents", label: "Pitch move that splits", min: 30, max: 300, step: 5, unit: "c" },
];

export function buildControls(root: HTMLElement, initial: Settings, onChange: (s: Settings) => void) {
  let s = { ...initial };
  root.innerHTML = "";
  const inputs = new Map<NumKey, [HTMLInputElement, HTMLElement]>();

  for (const d of SLIDERS) {
    const label = document.createElement("label");
    const val = document.createElement("span");
    const input = Object.assign(document.createElement("input"), { type: "range", min: String(d.min), max: String(d.max), step: String(d.step) });
    input.addEventListener("input", () => { s = { ...s, [d.key]: Number(input.value) }; sync(); onChange(s); });
    label.append(d.label, val, input);
    root.append(label);
    inputs.set(d.key, [input, val]);
  }

  const onset = document.createElement("label");
  const onsetVal = document.createElement("span");
  const onsetRange = Object.assign(document.createElement("input"), { type: "range", min: "0.1", max: "3", step: "0.05" });
  const onsetOff = Object.assign(document.createElement("input"), { type: "checkbox" });
  onsetRange.addEventListener("input", () => { s = { ...s, onset_delta: Number(onsetRange.value) }; sync(); onChange(s); });
  onsetOff.addEventListener("change", () => { s = { ...s, onset_delta: onsetOff.checked ? null : Number(onsetRange.value) }; sync(); onChange(s); });
  const offLabel = document.createElement("span");
  offLabel.append(onsetOff, " off");
  onset.append("Loudness re-attack", onsetVal, onsetRange, offLabel);
  root.append(onset);

  const buttons = document.createElement("div");
  const legato = Object.assign(document.createElement("button"), { textContent: "Legato" });
  const reset = Object.assign(document.createElement("button"), { textContent: "Reset" });
  const keepTuning = (base: Settings): Settings => ({ ...base, tuning_name: s.tuning_name, tuning_scl: s.tuning_scl, anchor_hz: s.anchor_hz });
  legato.addEventListener("click", () => { s = keepTuning({ ...DEFAULT_SETTINGS, ...LEGATO }); sync(); onChange(s); });
  reset.addEventListener("click", () => { s = keepTuning(DEFAULT_SETTINGS); sync(); onChange(s); });
  buttons.append(legato, " ", reset);
  root.append(buttons);

  const flags = document.createElement("p");
  const code = document.createElement("code");
  const copy = Object.assign(document.createElement("button"), { textContent: "Copy as flags" });
  copy.addEventListener("click", () => navigator.clipboard.writeText(code.textContent ?? ""));
  flags.append(code, " ", copy);
  root.append(flags);

  function sync() {
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
  }
  sync();
  return {
    set(next: Settings) { s = { ...next }; sync(); },
    setFlags(text: string) { code.textContent = text || "(defaults)"; },
  };
}
