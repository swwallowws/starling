import { describe, expect, it } from "vitest";
import { fromTime, midiToHz, noteAutomation, releaseLevel } from "./synth";
import type { RNote } from "./types";

const n = (over: Partial<RNote> = {}): RNote => ({ pitch: 69, center: 69, start: 1, end: 2, velocity: 0.8, cause: "gap", bend: [], amp: [], ...over });

describe("synth", () => {
  it("A4 is 440 Hz", () => expect(midiToHz(69)).toBeCloseTo(440));
  it("a note without curves holds its pitch and velocity", () => {
    const a = noteAutomation(n());
    expect(a.freq).toEqual([[1, midiToHz(69)]]);
    expect(a.gain[0][1]).toBeCloseTo(0.25 * 0.8);
  });
  it("follows the bend curve in semitones", () => {
    const a = noteAutomation(n({ bend: [[1, 0], [1.5, 1]] }));
    expect(a.freq[1][1]).toBeCloseTo(466.16, 1);
  });
  it("starting mid-note carries the current value to the start point", () => {
    const a = fromTime(noteAutomation(n({ bend: [[1, 0], [1.2, 0.5], [1.8, 1]] })), 1.5)!;
    expect(a.start).toBe(1.5);
    expect(a.freq[0]).toEqual([1.5, midiToHz(69.5)]);
    expect(a.freq[1][0]).toBe(1.8);
  });
  it("fades out from the note's own last level, not from silence", () => {
    expect(releaseLevel(noteAutomation(n({ amp: [[1, 0.8], [1.5, 0.4]] })))).toBeCloseTo(0.25 * 0.4);
    expect(releaseLevel(noteAutomation(n()))).toBeCloseTo(0.25 * 0.8);
  });
  it("notes that ended are dropped", () => {
    expect(fromTime(noteAutomation(n()), 3)).toBeNull();
  });
});
