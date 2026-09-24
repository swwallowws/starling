import { describe, expect, it } from "vitest";
import { fitView, pitchToY, timeToX, xToTime } from "./coords";
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
});
