/** Anchor choices: 12-TET note names with their frequency, C3 to B4. */
export interface AnchorNote { label: string; hz: number; }

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const formatHz = (hz: number) => hz.toFixed(1);

export function anchorNotes(): AnchorNote[] {
  const out: AnchorNote[] = [];
  for (let midi = 48; midi <= 71; midi++) {
    const hz = 440 * 2 ** ((midi - 69) / 12);
    out.push({ label: `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1} · ${formatHz(hz)} Hz`, hz });
  }
  return out;
}

/** The note whose frequency this is (to within 0.01 Hz), or null for a custom one. */
export function matchAnchor(hz: number): AnchorNote | null {
  return anchorNotes().find((n) => Math.abs(n.hz - hz) < 0.01) ?? null;
}
