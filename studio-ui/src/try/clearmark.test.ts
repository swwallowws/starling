import { describe, expect, it } from "vitest";
import { near, wordsNearText } from "./clearmark";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe("near", () => {
  it("counts an overlap", () => {
    expect(near(box(0, 0, 10, 10), box(5, 5, 20, 20), 0)).toBe(true);
  });
  it("keeps apart boxes further than pad", () => {
    expect(near(box(0, 0, 10, 10), box(0, 20, 10, 30), 8)).toBe(false);
  });
  it("counts boxes within pad", () => {
    expect(near(box(0, 0, 10, 10), box(0, 15, 10, 30), 8)).toBe(true);
  });
});

describe("wordsNearText", () => {
  it("picks only the words by a line of text", () => {
    // Two rows of words; the sentence's one line sits on the second row.
    const words = [box(0, 0, 40, 13), box(100, 0, 140, 13), box(0, 40, 40, 53), box(100, 40, 140, 53)];
    const lines = [box(20, 42, 90, 60)];
    expect(wordsNearText(words, lines, 4)).toEqual([false, false, true, false]);
  });
  it("uses every line of a wrapped sentence", () => {
    const words = [box(0, 0, 40, 13), box(0, 40, 40, 53)];
    const lines = [box(0, 2, 30, 10), box(0, 42, 30, 50)];
    expect(wordsNearText(words, lines, 0)).toEqual([true, true]);
  });
});
