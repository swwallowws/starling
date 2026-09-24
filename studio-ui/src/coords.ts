import type { RNote, TakeInfo } from "./types";

export interface View { t0: number; t1: number; pLo: number; pHi: number; width: number; height: number; }

const PAD = 2;
const MIN_SPAN = 12;

export function fitView(info: TakeInfo, notes: RNote[], width: number, height: number): View {
  const ps: number[] = [];
  for (const c of info.contour) if (c !== null) ps.push(c);
  for (const n of notes) ps.push(n.pitch, n.center);
  let lo = ps.length ? Math.min(...ps) - PAD : 57;
  let hi = ps.length ? Math.max(...ps) + PAD : 72;
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
