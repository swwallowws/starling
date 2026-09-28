// "MIDI + tuning for Live 12": an MPE .mid whose note numbers are steps of the
// tuning, and the matching .ascl for Live's Tuning section.
//
// How Live reads the pair (ASCL spec, help.ableton.com article 10998372840220):
// - `@ABL REFERENCE_PITCH <octave> <index> <Hz>` pins one note of the tuning to
//   a frequency. We pin the scale's 1/1 (index 0) to the studio's anchor.
// - `@ABL NOTE_RANGE_BY_INDEX <min octave> <min index> <max octave> <max index>`
//   sets the first usable note of the tuning, which Live puts on MIDI note 0;
//   the range runs at most 127 steps up from there. Octave and index count in
//   the same numbering as REFERENCE_PITCH (the spec requires REFERENCE_PITCH
//   first), octaves being periods of the scale.
// So MIDI note k plays step (lowest + k), and the .mid writes each note as
// its step minus `lowest`. The bends then carry only the glides and vibrato,
// measured from the tuned step.
//
// Which note sits where: the 1/1 on MIDI note 60 when the whole take fits
// that way (so a 12-note tuning lines up with the usual keyboard), otherwise
// the range is centred on the take. MIDI note 0 is never put below 8.18 Hz
// (the lowest note of standard MIDI), so few-note scales keep a usable range.

import { writeMpe, type MpeNote } from "./mpe-midi";
import { hzToMidi, parseScl, Steps, type Scale } from "./scala";
import type { RNote, Settings } from "./types";

/** The anchor's octave number in Live's naming, where middle C is C3. */
export function anchorOctave(anchorHz: number): number {
  // The small allowance keeps a C typed as 261.63 or 130.81 in its own octave.
  return Math.min(8, Math.max(-2, 3 + Math.floor(Math.log2(anchorHz / 261.6255653) + 1e-3)));
}

export const MIDI_KEYS = 128;
/** Standard MIDI note 0, 8.18 Hz. */
const LOWEST_HZ = 8.1757989;

/** Where the tuning's steps go on Live's 128 notes. */
export interface Range {
  /** The step on MIDI note 0. */
  lowest: number;
  /** Notes whose step falls outside the 128 keys (only when the take spans more). */
  outside: number;
}

/** Choose `lowest` for a take whose notes sit on `steps`. */
export function chooseRange(steps: number[], tuning: Steps): Range {
  if (!steps.length) return { lowest: -60, outside: 0 };
  const lo = Math.min(...steps);
  const hi = Math.max(...steps);
  // The lowest step at or above 8.18 Hz.
  let floor = Math.ceil(((1200 * Math.log2(LOWEST_HZ / tuning.anchorHz)) / tuning.scale.period) * tuning.n) - tuning.n;
  while (tuning.midi(floor) < hzToMidi(LOWEST_HZ) - 1e-9) floor++;
  const fits = (l: number) => l >= floor && l <= lo && l + MIDI_KEYS - 1 >= hi;
  if (fits(-60)) return { lowest: -60, outside: 0 };
  if (hi - lo <= MIDI_KEYS - 1) {
    const centred = lo - Math.floor((MIDI_KEYS - 1 - (hi - lo)) / 2);
    const lowest = Math.min(lo, Math.max(centred, floor, hi - (MIDI_KEYS - 1)));
    return { lowest, outside: 0 };
  }
  // Too wide for Live: keep the 128 steps around the middle of the take's notes.
  const sorted = [...steps].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const lowest = Math.max(floor, mid - Math.floor(MIDI_KEYS / 2));
  return { lowest, outside: steps.filter((s) => s < lowest || s > lowest + MIDI_KEYS - 1).length };
}

const fmtCents = (c: number) => c.toFixed(6);

/** The .ascl text for `scale` with its 1/1 at `anchorHz` and `lowest` on MIDI note 0. */
export function writeAscl(scale: Scale, anchorHz: number, lowest: number, name: string): string {
  const n = scale.degrees.length;
  const oct = anchorOctave(anchorHz);
  const at = (s: number) => {
    const k = Math.floor(s / n);
    return `${oct + k} ${s - k * n}`;
  };
  const lines = [
    `! ${name}.ascl`,
    "!",
    `! Made by Starling for Ableton Live 12. MIDI note 0 plays step ${lowest} from the 1/1,`,
    `! so the Starling MIDI made with this file plays in tune.`,
    "!",
    scale.description || name,
    ` ${n}`,
    ...scale.degrees.slice(1).map((c) => ` ${fmtCents(c)}`),
    ` ${fmtCents(scale.period)}`,
    "!",
    `! @ABL REFERENCE_PITCH ${oct} 0 ${anchorHz.toFixed(4)}`,
    `! @ABL NOTE_RANGE_BY_INDEX ${at(lowest)} ${at(lowest + MIDI_KEYS - 1)}`,
    "! @ABL SOURCE Starling",
    "",
  ];
  return lines.join("\n");
}

/** Semitones between a 12-TET key plus its bend and a tuned step. */
const shift = (n: RNote, stepMidi: number) => n.pitch - stepMidi;

/** A rendered note as an MPE note on its 12-TET key: tuning offset and glides in the bend. */
export const anySynthNote = (n: RNote): MpeNote => ({
  key: n.pitch,
  start: n.start,
  end: n.end,
  velocity: n.velocity,
  bend: n.bend.length ? n.bend : [[n.start, 0]],
  amp: n.amp,
});

export interface LiveExport {
  mid: Uint8Array<ArrayBuffer>;
  ascl: string;
  range: Range;
  /** Notes written (those inside Live's 128 keys). */
  written: number;
}

/**
 * The Live pair for `notes` rendered with `settings` (which must carry a .scl).
 * Each note's step is the engine's snap of its sung centre; its bend is moved
 * from the 12-TET key to that step, so what sounds is unchanged.
 */
export function liveExport(notes: RNote[], settings: Settings, name: string): LiveExport {
  if (!settings.tuning_scl) throw new Error("the Live tuning export needs a tuning other than 12-TET");
  const scale = parseScl(settings.tuning_scl);
  const tuning = new Steps(scale, settings.anchor_hz);
  const steps = notes.map((n) => tuning.snap(n.center));
  const range = chooseRange(steps, tuning);
  const out: MpeNote[] = [];
  notes.forEach((n, i) => {
    const key = steps[i] - range.lowest;
    if (key < 0 || key >= MIDI_KEYS) return;
    const d = shift(n, tuning.midi(steps[i]));
    const bend: [number, number][] = n.bend.length ? n.bend.map(([t, b]) => [t, b + d]) : [[n.start, d]];
    out.push({ key, start: n.start, end: n.end, velocity: n.velocity, bend, amp: n.amp });
  });
  return { mid: writeMpe(out), ascl: writeAscl(scale, settings.anchor_hz, range.lowest, name), range, written: out.length };
}

/** A file-name-safe version of a tuning name ("53-edo", "my scale.scl"). */
export const tuningStem = (name: string | null) =>
  (name ?? "tuning").replace(/\.(scl|ascl)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-") || "tuning";

export interface MadeFile {
  kind: "mid" | "ascl";
  file_name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * The files for "MIDI + tuning for Live 12" and a line saying what to do with
 * them. In 12-TET Live needs no tuning file, so it is just the MPE .mid.
 */
export function liveFiles(notes: RNote[], settings: Settings, stem: string): { files: MadeFile[]; note: string } {
  if (!settings.tuning_scl) {
    return {
      files: [{ kind: "mid", file_name: `${stem}_live12.mid`, bytes: writeMpe(notes.map(anySynthNote)) }],
      note: "12-TET needs no tuning file in Live: drag the MIDI in as it is.",
    };
  }
  const t = tuningStem(settings.tuning_name);
  const r = liveExport(notes, settings, t);
  const mid = `${stem}_live12_${t}.mid`;
  const ascl = `${t}.ascl`;
  const outside = r.range.outside
    ? ` ${r.range.outside} of ${notes.length} notes are beyond Live's 128 notes in this tuning and were left out.`
    : "";
  return {
    files: [
      { kind: "mid", file_name: mid, bytes: r.mid },
      { kind: "ascl", file_name: ascl, bytes: new TextEncoder().encode(r.ascl) },
    ],
    note: `Live 12: load ${ascl} in the Tuning section, then drag ${mid} in.${outside}`,
  };
}
