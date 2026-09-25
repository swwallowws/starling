import { describe, expect, it } from "vitest";
import { plausibleContour } from "./contour";
import type { RNote } from "./types";

const note = (pitch: number, start: number, end: number): RNote => ({
  pitch,
  center: pitch,
  start,
  end,
  velocity: 1,
  cause: "gap",
  bend: [],
  amp: [],
});

describe("plausibleContour", () => {
  const notes = [note(53, 0.0, 0.03), note(60, 0.05, 0.08)];

  it("hides readings more than 6 semitones from the nearest note in time", () => {
    // Frames at 0, 0.01, ... 0.08 s: a dive to F#2 (42) during the F3 (53)
    // note, a gap reading between the notes, and readings on the C4 (60) note.
    // 66 is exactly 6 semitones above C4 and stays; 67 is 7 and goes.
    const contour = [53, 42, 53.5, 55, 50, 60, 66, 67, null];
    expect(plausibleContour(contour, 0.01, notes)).toEqual([53, null, 53.5, 55, 50, 60, 66, null, null]);
  });

  it("keeps everything when there are no notes yet", () => {
    expect(plausibleContour([40, 80, null], 0.01, [])).toEqual([40, 80, null]);
  });
});
