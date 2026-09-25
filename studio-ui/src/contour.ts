import type { RNote } from "./types";

/** Same limit the engine uses for bends: further than this from its note, a
 *  reading is a misreading (octave error, breath), not singing. */
const MAX_FROM_NOTE = 6;

/** The sung contour with implausible readings hidden (null): those more than
 *  6 semitones from the nearest note in time. With no notes, everything stays. */
export function plausibleContour(contour: (number | null)[], hopS: number, notes: RNote[]): (number | null)[] {
  if (!notes.length) return contour;
  return contour.map((c, i) => {
    if (c === null) return null;
    const t = i * hopS;
    let nearest = notes[0];
    let best = Infinity;
    for (const n of notes) {
      const d = t < n.start ? n.start - t : t > n.end ? t - n.end : 0;
      if (d < best) {
        best = d;
        nearest = n;
      }
    }
    return Math.abs(c - nearest.pitch) <= MAX_FROM_NOTE ? c : null;
  });
}
