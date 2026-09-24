/** The part of the roll on screen: a time range (s) and a pitch range (semitones). */
export interface Win { t0: number; t1: number; pLo: number; pHi: number; }

/** Closest zoom: 50 ms across, one semitone tall. */
const MIN_T = 0.05;
const MIN_P = 1;
/** Where a paged window puts the playhead, as a fraction from the left. */
const LEAD = 0.1;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Shift one axis so [a, a+span] sits inside [lo, hi]. */
function fitAxis(a: number, span: number, lo: number, hi: number): [number, number] {
  const s = clamp(span, 0, hi - lo);
  const start = clamp(a, lo, hi - s);
  return [start, start + s];
}

/** `w` resized to at most the fitted view (and at least the minimum zoom), then moved inside it. */
export function clampWin(w: Win, fit: Win): Win {
  const tSpan = clamp(w.t1 - w.t0, Math.min(MIN_T, fit.t1 - fit.t0), fit.t1 - fit.t0);
  const pSpan = clamp(w.pHi - w.pLo, Math.min(MIN_P, fit.pHi - fit.pLo), fit.pHi - fit.pLo);
  const [t0, t1] = fitAxis(w.t0, tSpan, fit.t0, fit.t1);
  const [pLo, pHi] = fitAxis(w.pLo, pSpan, fit.pLo, fit.pHi);
  return { t0, t1, pLo, pHi };
}

/** Zoom by `factor` (< 1 zooms in) around the point `fx` across and `fy` down the window. */
export function zoomAt(w: Win, fit: Win, fx: number, fy: number, factor: number): Win {
  const tSpan = clamp((w.t1 - w.t0) * factor, MIN_T, fit.t1 - fit.t0);
  const pSpan = clamp((w.pHi - w.pLo) * factor, MIN_P, fit.pHi - fit.pLo);
  const t = w.t0 + fx * (w.t1 - w.t0);
  const p = w.pHi - fy * (w.pHi - w.pLo);
  const t0 = t - fx * tSpan;
  const pHi = p + fy * pSpan;
  return clampWin({ t0, t1: t0 + tSpan, pLo: pHi - pSpan, pHi }, fit);
}

/** Move later by `dt` and higher by `dp`, both as fractions of the window. */
export function panBy(w: Win, fit: Win, dt: number, dp: number): Win {
  const st = dt * (w.t1 - w.t0);
  const sp = dp * (w.pHi - w.pLo);
  return clampWin({ t0: w.t0 + st, t1: w.t1 + st, pLo: w.pLo + sp, pHi: w.pHi + sp }, fit);
}

/** One animation frame toward `target`; lands exactly on it once close. */
export function step(cur: Win, target: Win, k: number): [Win, boolean] {
  const eps = 1e-3 * Math.min(target.t1 - target.t0, target.pHi - target.pLo);
  const keys = ["t0", "t1", "pLo", "pHi"] as const;
  if (keys.every((key) => Math.abs(cur[key] - target[key]) < eps)) return [target, true];
  const next = { ...cur };
  for (const key of keys) next[key] = cur[key] + (target[key] - cur[key]) * k;
  return [next, false];
}

/** While playing: once the playhead leaves the window, page it so the playhead sits near the left. */
export function follow(w: Win, fit: Win, playhead: number): Win {
  if (playhead >= w.t0 && playhead < w.t1) return w;
  const span = w.t1 - w.t0;
  const t0 = playhead - LEAD * span;
  return clampWin({ ...w, t0, t1: t0 + span }, fit);
}

export function isFit(w: Win, fit: Win): boolean {
  return (["t0", "t1", "pLo", "pHi"] as const).every((k) => Math.abs(w[k] - fit[k]) < 1e-6);
}
