import { describe, expect, it } from "vitest";
import { isBlackKey, noteStrength, parseRgb, tint } from "./colors";

describe("colors", () => {
  it("parses computed rgb and rgba strings", () => {
    expect(parseRgb("rgb(0, 116, 137)")).toEqual([0, 116, 137]);
    expect(parseRgb("rgba(242, 242, 238, 0.5)")).toEqual([242, 242, 238]);
  });
  it("tints between the ground and the accent", () => {
    expect(tint("rgb(0, 116, 137)", "rgb(239, 238, 233)", 1)).toBe("rgb(0, 116, 137)");
    expect(tint("rgb(0, 116, 137)", "rgb(239, 238, 233)", 0)).toBe("rgb(239, 238, 233)");
    expect(tint("rgb(0, 100, 200)", "rgb(200, 100, 0)", 0.5)).toBe("rgb(100, 100, 100)");
  });
  it("pitch maps to tint strength from 40% at the lowest note to 100% at the highest", () => {
    expect(noteStrength(60, 60, 72)).toBeCloseTo(0.4);
    expect(noteStrength(72, 60, 72)).toBeCloseTo(1);
    expect(noteStrength(66, 60, 72)).toBeCloseTo(0.7);
    expect(noteStrength(50, 60, 72)).toBeCloseTo(0.4);
    expect(noteStrength(64, 64, 64)).toBe(1);
  });
  it("knows the black keys", () => {
    expect([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map(isBlackKey)).toEqual(
      [false, true, false, true, false, false, true, false, true, false, true, false],
    );
  });
});
