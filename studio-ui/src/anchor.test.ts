import { describe, expect, it } from "vitest";
import { anchorNotes, formatHz, matchAnchor } from "./anchor";

describe("anchor", () => {
  it("lists note names with one-decimal frequencies", () => {
    const notes = anchorNotes();
    expect(notes.find((n) => n.label.startsWith("C4"))!.label).toBe("C4 · 261.6 Hz");
    expect(notes.find((n) => n.label.startsWith("A4"))!.hz).toBeCloseTo(440);
    expect(notes[0].label.startsWith("C3")).toBe(true);
    expect(notes[notes.length - 1].label.startsWith("B4")).toBe(true);
  });
  it("formats Hz with one decimal", () => {
    expect(formatHz(261.625565)).toBe("261.6");
    expect(formatHz(440)).toBe("440.0");
  });
  it("finds the note for a frequency, or none for a custom one", () => {
    expect(matchAnchor(261.625565)?.label.startsWith("C4")).toBe(true);
    expect(matchAnchor(432)).toBeNull();
  });
});
