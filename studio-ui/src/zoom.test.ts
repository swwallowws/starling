import { describe, expect, it } from "vitest";
import { clampWin, follow, isFit, panBy, step, zoomAt, type Win } from "./zoom";

const fit: Win = { t0: 0, t1: 10, pLo: 48, pHi: 72 };

describe("zoomAt", () => {
  it("keeps the point under the cursor fixed", () => {
    const w = zoomAt(fit, fit, 0.25, 0.5, 0.5);
    expect(w.t1 - w.t0).toBeCloseTo(5);
    expect(w.pHi - w.pLo).toBeCloseTo(12);
    // 0.25 across was t = 2.5 and stays 0.25 across.
    expect(w.t0 + 0.25 * (w.t1 - w.t0)).toBeCloseTo(2.5);
    // halfway down was p = 60 and stays halfway down.
    expect(w.pHi - 0.5 * (w.pHi - w.pLo)).toBeCloseTo(60);
  });
  it("never zooms out past the fitted view", () => {
    expect(zoomAt(fit, fit, 0.5, 0.5, 4)).toEqual(fit);
  });
  it("stops at a minimum span", () => {
    let w = fit;
    for (let i = 0; i < 40; i++) w = zoomAt(w, fit, 0.5, 0.5, 0.5);
    expect(w.t1 - w.t0).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(w.pHi - w.pLo).toBeGreaterThanOrEqual(1 - 1e-9);
  });
});

describe("panBy", () => {
  it("moves by fractions of the window and stays inside the fit", () => {
    const w = zoomAt(fit, fit, 0, 1, 0.5); // t 0..5, p 48..60
    const moved = panBy(w, fit, 0.2, 0.5);
    expect(moved.t0).toBeCloseTo(1);
    expect(moved.pLo).toBeCloseTo(54);
    const far = panBy(w, fit, 5, -5);
    expect(far.t1).toBeCloseTo(10);
    expect(far.pLo).toBeCloseTo(48);
  });
});

describe("clampWin", () => {
  it("fits a window inside the fitted view without resizing it when possible", () => {
    const w = clampWin({ t0: 8, t1: 12, pLo: 70, pHi: 76 }, fit);
    expect(w).toEqual({ t0: 6, t1: 10, pLo: 66, pHi: 72 });
  });
  it("keeps a zoom when the fitted pitch range shrinks around it", () => {
    const narrow: Win = { t0: 0, t1: 10, pLo: 55, pHi: 67 };
    const w = clampWin({ t0: 2, t1: 4, pLo: 50, pHi: 56 }, narrow);
    expect(w).toEqual({ t0: 2, t1: 4, pLo: 55, pHi: 61 });
  });
});

describe("step", () => {
  it("glides toward the target and lands on it", () => {
    const target = zoomAt(fit, fit, 0.5, 0.5, 0.5);
    let cur = fit;
    let done = false;
    let frames = 0;
    while (!done && frames < 200) [cur, done] = step(cur, target, 0.3), frames++;
    expect(done).toBe(true);
    expect(cur).toEqual(target);
    expect(frames).toBeGreaterThan(3);
    const [half] = step(fit, target, 0.5);
    expect(half.t0).toBeCloseTo((fit.t0 + target.t0) / 2);
  });
});

describe("follow", () => {
  it("pages the window when the playhead runs off either edge", () => {
    const w: Win = { t0: 2, t1: 4, pLo: 48, pHi: 60 };
    expect(follow(w, fit, 3)).toBe(w);
    const next = follow(w, fit, 4.5);
    expect(next.t0).toBeCloseTo(4.3);
    expect(next.t1 - next.t0).toBeCloseTo(2);
    expect(follow(w, fit, 9.9).t1).toBeCloseTo(10);
    expect(follow(w, fit, 0.5).t0).toBeCloseTo(0.3);
  });
});

describe("isFit", () => {
  it("is true only for the whole view", () => {
    expect(isFit(fit, fit)).toBe(true);
    expect(isFit(zoomAt(fit, fit, 0.5, 0.5, 0.9), fit)).toBe(false);
  });
});
