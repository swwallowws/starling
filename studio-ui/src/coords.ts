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
export const pitchToY = (v: View, p: number) => v.height - ((p - v.pLo) / (v.pHi - v.pLo)) * v.height;
