import { clampTime } from "../vendor/design/playhead.js";
import type { RNote, TakeInfo } from "./types";

export interface View { t0: number; t1: number; pLo: number; pHi: number; width: number; height: number; }

const PAD = 2;
const MIN_SPAN = 12;
const OUTLIER = 12;

export function fitView(info: TakeInfo, notes: RNote[], width: number, height: number): View {
  const ps: number[] = [];
  for (const n of notes) ps.push(n.pitch, n.center);
  // The sung contour widens the view only near the notes: readings more than
  // an octave outside them are misreadings (breaths, octave errors).
  let nLo = Infinity;
  let nHi = -Infinity;
  for (const p of ps) { nLo = Math.min(nLo, p); nHi = Math.max(nHi, p); }
  for (const c of info.contour) {
    if (c === null) continue;
    if (!ps.length || (c >= nLo - OUTLIER && c <= nHi + OUTLIER)) ps.push(c);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ps) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  lo = ps.length ? lo - PAD : 57;
  hi = ps.length ? hi + PAD : 72;
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  return { t0: 0, t1: Math.max(info.duration_s, 0.001), pLo: lo, pHi: hi, width, height };
}

export const timeToX = (v: View, t: number) => ((t - v.t0) / (v.t1 - v.t0)) * v.width;
export const xToTime = (v: View, x: number) => v.t0 + (x / v.width) * (v.t1 - v.t0);
/** The time under a pointer at `clientX` over a roll box that starts at `left` and is
 *  `width` CSS px wide, showing view `v`, clamped to the take (0 to `end`). */
export function pointerTime(v: View, clientX: number, left: number, width: number, end: number): number {
  if (!(width > 0)) return clampTime(v.t0, end);
  return clampTime(xToTime(v, ((clientX - left) / width) * v.width), end);
}

/** Half the playhead line's grab band (px), as playhead.css draws it. */
export const HEAD_GRAB = 6;

/** Whether a press at `x` (px in the view) lands on the playhead line. */
export const onHead = (v: View, playhead: number | null, x: number) =>
  playhead !== null && Math.abs(timeToX(v, playhead) - x) <= HEAD_GRAB;

export const pitchToY =(v: View, p: number) => v.height - ((p - v.pLo) / (v.pHi - v.pLo)) * v.height;
