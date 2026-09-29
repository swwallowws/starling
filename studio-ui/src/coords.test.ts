import { describe, expect, it } from "vitest";
import { HEAD_GRAB, fitView, onHead, pitchToY, pointerTime, timeToX, xToTime } from "./coords";
import type { RNote, TakeInfo } from "./types";

const info: TakeInfo = { name: "t", duration_s: 4, hop_s: 0.01, contour: [60, null, 62.5], loudness: [0, 1, 0.5], warning: null };
const note = (pitch: number): RNote => ({ pitch, center: pitch, start: 1, end: 2, velocity: 1, cause: "gap", bend: [], amp: [] });

describe("coords", () => {
  it("fits every note and the contour with padding and at least an octave", () => {
    const v = fitView(info, [note(64)], 800, 400);
    expect(v.t0).toBe(0);
    expect(v.t1).toBe(4);
    expect(v.pLo).toBeLessThanOrEqual(58);
    expect(v.pHi).toBeGreaterThanOrEqual(66);
    expect(v.pHi - v.pLo).toBeGreaterThanOrEqual(12);
  });
  it("time and x are inverses", () => {
    const v = fitView(info, [], 800, 400);
    expect(xToTime(v, timeToX(v, 1.25))).toBeCloseTo(1.25);
  });
  it("higher pitch is higher on screen", () => {
    const v = fitView(info, [], 800, 400);
    expect(pitchToY(v, 70)).toBeLessThan(pitchToY(v, 60));
  });
  it("an empty take still gets a sane view", () => {
    const v = fitView({ ...info, contour: [], duration_s: 0 }, [], 800, 400);
    expect(v.t1).toBeGreaterThan(v.t0);
    expect(v.pHi).toBeGreaterThan(v.pLo);
  });
  it("ignores stray contour readings far outside the notes", () => {
    const noisy: TakeInfo = { ...info, contour: [60, 62, 24, 30, 61] };
    const v = fitView(noisy, [note(60), note(64)], 800, 400);
    expect(v.pLo).toBeGreaterThan(40);
  });
  it("maps a pointer to the time under it, zoomed or not, clamped to the take", () => {
    const fit = fitView(info, [], 800, 400);
    // The box sits at 100px and is drawn at 400 CSS px while the view is 800 wide.
    expect(pointerTime(fit, 300, 100, 400, 4)).toBeCloseTo(2);
    const zoomed = { ...fit, t0: 1, t1: 2 };
    expect(pointerTime(zoomed, 200, 100, 400, 4)).toBeCloseTo(1.25);
    expect(pointerTime(fit, 50, 100, 400, 4)).toBe(0);
    expect(pointerTime(fit, 900, 100, 400, 4)).toBe(4);
    expect(pointerTime(zoomed, 300, 100, 0, 4)).toBe(1);
  });
  it("finds the playhead line within its grab band", () => {
    const v = fitView(info, [], 800, 400);
    expect(onHead(v, 1, 200 + HEAD_GRAB)).toBe(true);
    expect(onHead(v, 1, 200 + HEAD_GRAB + 1)).toBe(false);
    expect(onHead(v, null, 0)).toBe(false);
  });
});
