import { describe, expect, it } from "vitest";
import { anchorOctave, chooseRange, liveExport, liveFiles, tuningStem, writeAscl } from "./live-export";
import { bendOf, readMidi } from "./midi-read";
import { BEND_RANGE } from "./mpe-midi";
import { parseScl, Steps } from "./scala";
import { DEFAULT_SETTINGS, type RNote } from "./types";

const MIDDLE_C = 261.625565;
const edo = (n: number) =>
  `! ${n}-edo.scl\n${n}-EDO\n ${n}\n${Array.from({ length: n - 1 }, (_, i) => ` ${(((i + 1) * 1200) / n).toFixed(5)}`).join("\n")}\n 2/1\n`;
const EDO53 = edo(53);
const JI = "! ji.scl\nJI major\n 7\n 9/8\n 5/4\n 4/3\n 3/2\n 5/3\n 15/8\n 2/1\n";
const settings53 = { ...DEFAULT_SETTINGS, tuning_name: "53-edo", tuning_scl: EDO53 };

/** A rendered note the way the engine hands it over: a 12-TET key, and the bend from it. */
function rendered(steps: Steps, step: number, start: number, glide: [number, number][] = [[0, 0]]): RNote {
  const m = steps.midi(step);
  const pitch = Math.round(m);
  return {
    pitch,
    center: m + 0.03, // sung a little sharp; snaps back to the step
    start,
    end: start + 0.4,
    velocity: 0.7,
    cause: "gap",
    bend: glide.map(([t, g]) => [start + t, m - pitch + g]),
    amp: [[start, 0.6]],
  };
}

describe("scala", () => {
  it("parses cents, ratios and the period, degrees sorted from 0", () => {
    const s = parseScl(JI);
    expect(s.degrees.length).toBe(7);
    expect(s.degrees[0]).toBe(0);
    expect(s.degrees[2]).toBeCloseTo(386.3137, 3);
    expect(s.period).toBeCloseTo(1200, 9);
    expect(parseScl(EDO53).degrees.length).toBe(53);
    expect(() => parseScl("x\n 3\n 100.0\n")).toThrow(/declared 3/);
  });

  it("numbers 53-EDO steps from the anchor and snaps like the engine", () => {
    const t = new Steps(parseScl(EDO53), MIDDLE_C);
    expect(t.midi(0)).toBeCloseTo(60, 6);
    expect(t.midi(53)).toBeCloseTo(72, 6);
    expect(t.midi(-53)).toBeCloseTo(48, 6);
    expect(t.midi(9)).toBeCloseTo(60 + (9 * 12) / 53, 6);
    expect(t.snap(62)).toBe(9); // D: 9 steps (203.8 c) is the closest
    expect(t.snap(59.9)).toBe(0);
    expect(t.snap(71.95)).toBe(53); // just under the octave snaps up to the next 1/1
    expect(t.snap(47.5)).toBe(-2 * 53 + 51); // 1150 cents into the octave below: step 51 (1154.7 c)
  });
});

describe("Live range", () => {
  const t = new Steps(parseScl(EDO53), MIDDLE_C);
  it("puts the 1/1 on MIDI note 60 when the take fits that way", () => {
    expect(chooseRange([-20, 0, 40], t)).toEqual({ lowest: -60, outside: 0 });
  });
  it("centres a take that doesn't fit around note 60", () => {
    const r = chooseRange([60, 100], t);
    expect(r.outside).toBe(0);
    expect(r.lowest).toBe(60 - Math.floor((127 - 40) / 2));
  });
  it("counts the notes a take wider than 128 steps loses", () => {
    const r = chooseRange([-100, 0, 1, 2, 100], t);
    expect(r.outside).toBe(2);
    expect(r.lowest).toBe(1 - 64);
  });
  it("keeps MIDI note 0 at or above 8.18 Hz for a scale with few notes", () => {
    const ji = new Steps(parseScl(JI), MIDDLE_C);
    const r = chooseRange([0, 7], ji);
    expect(ji.midi(r.lowest)).toBeGreaterThanOrEqual(-1e-6);
    expect(ji.midi(r.lowest - 1)).toBeLessThan(0);
  });
});

describe(".ascl", () => {
  it("writes the scale, the 1/1 at the anchor, and the 128-note range from MIDI note 0", () => {
    const text = writeAscl(parseScl(EDO53), MIDDLE_C, -60, "53-edo");
    const lines = text.split("\n").filter((l) => !l.startsWith("!"));
    expect(lines[0]).toBe("53-EDO");
    expect(lines[1].trim()).toBe("53");
    expect(lines.slice(2, 55).length).toBe(53);
    expect(lines[2].trim()).toBe("22.641510"); // the test scale's 22.64151, to a millionth of a cent
    expect(lines[54].trim()).toBe("1200.000000");
    expect(text).toContain("! @ABL REFERENCE_PITCH 3 0 261.6256");
    // Step -60 is octave 3-2 index 46; step 67 is octave 3+1 index 14.
    expect(text).toContain("! @ABL NOTE_RANGE_BY_INDEX 1 46 4 14");
    // The directives come after the pitch list, as the spec asks.
    expect(text.indexOf("@ABL")).toBeGreaterThan(text.indexOf(" 1200.000000"));
  });
  it("names the anchor's octave the way Live does (middle C is C3)", () => {
    expect(anchorOctave(261.625565)).toBe(3);
    expect(anchorOctave(440)).toBe(3);
    expect(anchorOctave(130.8128)).toBe(2);
    expect(anchorOctave(523.2511)).toBe(4);
  });
});

describe("Live export", () => {
  const t = new Steps(parseScl(EDO53), MIDDLE_C);
  it("writes 53-EDO steps as note numbers and leaves only the glide in the bend", () => {
    const notes = [rendered(t, 0, 0), rendered(t, 9, 0.5, [[0, -0.5], [0.2, 0]]), rendered(t, 31, 1)];
    const r = liveExport(notes, settings53, "53-edo");
    expect(r.range.lowest).toBe(-60);
    const evs = readMidi(r.mid).tracks[0];
    const ons = evs.filter((e) => e.type === 0x90);
    expect(ons.map((e) => e.data[0])).toEqual([60, 69, 91]);
    const bends = (ch: number) => evs.filter((e) => e.type === 0xe0 && e.channel === ch).map(bendOf);
    expect(bends(1)).toEqual([8192]);
    expect(bends(2)).toEqual([8192 - 85, 8192]); // -0.5 st scoop, then on the step
    expect(bends(3)).toEqual([8192]);
  });

  it("sounds the same pitch as the any-synth file: step + bend = key + bend", () => {
    const n = rendered(t, 17, 0, [[0, 0.3]]);
    const r = liveExport([n], settings53, "53-edo");
    const evs = readMidi(r.mid).tracks[0];
    const key = evs.find((e) => e.type === 0x90)!.data[0];
    const bend = ((bendOf(evs.find((e) => e.type === 0xe0)!) - 8192) * BEND_RANGE) / 8192;
    expect(t.midi(key + r.range.lowest) + bend).toBeCloseTo(n.pitch + n.bend[0][1], 2);
  });

  it("makes a .mid and an .ascl, and says what to do with them", () => {
    const out = liveFiles([rendered(t, 0, 0)], settings53, "take1");
    expect(out.files.map((f) => [f.kind, f.file_name])).toEqual([
      ["mid", "take1_live12_53-edo.mid"],
      ["ascl", "53-edo.ascl"],
    ]);
    expect(out.note).toBe("Live 12: load 53-edo.ascl in the Tuning section, then drag take1_live12_53-edo.mid in.");
  });

  it("in 12-TET makes just the MPE .mid on 12-TET keys", () => {
    const n: RNote = { pitch: 64, center: 64.1, start: 0, end: 0.5, velocity: 1, cause: "gap", bend: [[0, 0.1]], amp: [] };
    const out = liveFiles([n], DEFAULT_SETTINGS, "take1");
    expect(out.files.map((f) => f.file_name)).toEqual(["take1_live12.mid"]);
    const evs = readMidi(out.files[0].bytes).tracks[0];
    expect(evs.find((e) => e.type === 0x90)!.data[0]).toBe(64);
    expect(out.note).toMatch(/no tuning file/);
  });

  it("warns when notes fall outside Live's 128 notes", () => {
    const notes = [rendered(t, -100, 0), rendered(t, 0, 0.5), rendered(t, 1, 1), rendered(t, 100, 1.5)];
    const out = liveFiles(notes, settings53, "take1");
    expect(out.note).toMatch(/2 of 4 notes are beyond Live's 128 notes/);
    const ons = readMidi(out.files[0].bytes).tracks[0].filter((e) => e.type === 0x90);
    expect(ons.length).toBe(2);
  });

  it("makes safe file names from tuning names", () => {
    expect(tuningStem("my scale.scl")).toBe("my-scale");
    expect(tuningStem("53-edo")).toBe("53-edo");
    expect(tuningStem(null)).toBe("tuning");
  });
});
