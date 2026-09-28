import { describe, expect, it } from "vitest";
import { bendOf, readMidi, type MidiEvent } from "./midi-read";
import { bendValue, memberChannel, ticks, velocityValue, writeMpe, type MpeNote } from "./mpe-midi";

const note = (key: number, start: number, bend: [number, number][] = []): MpeNote => ({
  key,
  start,
  end: start + 0.25,
  velocity: 0.8,
  bend,
  amp: [[start, 0.5]],
});

const events = (notes: MpeNote[]) => readMidi(writeMpe(notes)).tracks[0];
const ccs = (evs: MidiEvent[]) => evs.filter((e) => e.type === 0xb0);

/** The value RPN `param` is set to on `channel`, read the way a synth would. */
function rpnValue(evs: MidiEvent[], channel: number, param: number): number | undefined {
  const c = ccs(evs).filter((e) => e.channel === channel).map((e) => e.data);
  for (let i = 0; i + 2 < c.length; i++) {
    if (c[i][0] === 101 && c[i][1] === 0 && c[i + 1][0] === 100 && c[i + 1][1] === param && c[i + 2][0] === 6) return c[i + 2][1];
  }
  return undefined;
}

describe("MPE writer", () => {
  it("writes a format 0 file at 480 ticks per beat and 120 BPM", () => {
    const f = readMidi(writeMpe([note(60, 0)]));
    expect([f.format, f.ticksPerBeat, f.tracks.length]).toEqual([0, 480, 1]);
    const tempo = f.tracks[0].find((e) => e.type === 0xff && e.data[0] === 0x51)!;
    expect(tempo.data.slice(1)).toEqual([0x07, 0xa1, 0x20]); // 500000 us per beat
    expect(ticks(1)).toBe(960);
  });

  it("declares a lower zone of 15 member channels, then ±48 on every channel, before any note", () => {
    const evs = events([note(60, 0)]);
    expect(rpnValue(evs, 0, 6)).toBe(15);
    for (let ch = 0; ch < 16; ch++) expect(rpnValue(evs, ch, 0)).toBe(48);
    // The MPE Configuration Message resets bend ranges, so it comes first.
    const first = ccs(evs).findIndex((e) => e.data[0] === 100);
    expect(ccs(evs)[first]).toMatchObject({ channel: 0, data: [100, 6] });
    const firstNote = evs.findIndex((e) => e.type === 0x90);
    const lastSetup = evs.map((e) => e.data[0] === 100 && e.data[1] === 127).lastIndexOf(true);
    expect(lastSetup).toBeLessThan(firstNote);
  });

  it("rotates notes through member channels 2-16 and never uses the master channel", () => {
    const notes = Array.from({ length: 17 }, (_, i) => note(60 + i, i * 0.5));
    const chans = events(notes).filter((e) => e.type === 0x90).map((e) => e.channel);
    expect(chans).toEqual([...Array.from({ length: 15 }, (_, i) => i + 1), 1, 2]);
    expect(memberChannel(15)).toBe(1);
  });

  it("puts each note's bend on its own channel, before its note-on", () => {
    const evs = events([note(60, 0, [[0, 0.5]]), note(62, 0.25, [[0.25, -1]])]);
    for (const on of evs.filter((e) => e.type === 0x90)) {
      const bend = evs.find((e) => e.type === 0xe0 && e.channel === on.channel)!;
      expect(evs.indexOf(bend)).toBeLessThan(evs.indexOf(on));
      expect(bend.tick).toBe(on.tick);
    }
    const bends = evs.filter((e) => e.type === 0xe0).map((e) => [e.channel, bendOf(e)]);
    expect(bends).toEqual([
      [1, 8192 + 85],
      [2, 8192 - 171],
    ]);
  });

  it("encodes bends over ±48 semitones", () => {
    expect(bendValue(0)).toBe(8192);
    expect(bendValue(48)).toBe(16383);
    expect(bendValue(-48)).toBe(0);
    expect(bendValue(60)).toBe(16383);
    expect(bendValue(1)).toBe(8363); // 8192 + 170.67
    // 53-EDO: one step is 1200/53 = 22.64 cents, 38.6 bend units at ±48.
    expect(bendValue(1200 / 53 / 100)).toBe(8231);
    // A 53-EDO step 9 (203.8 cents) written on 12-TET key +2: 3.8 cents sharp.
    expect(bendValue((9 * 1200) / 53 / 100 - 2)).toBe(8192 + 6);
  });

  it("scales velocity and loudness like the engine", () => {
    expect(velocityValue(0)).toBe(1);
    expect(velocityValue(1)).toBe(127);
    expect(velocityValue(0.5)).toBe(64);
    const cc11 = ccs(events([note(60, 0)])).find((e) => e.data[0] === 11)!;
    expect(cc11.data[1]).toBe(64);
  });

  it("ends a note one tick after its start at the least, note-offs before re-onsets", () => {
    const evs = events([{ ...note(60, 0), end: 0 }, note(60, 0.25)]);
    const offs = evs.filter((e) => e.type === 0x80);
    expect(offs[0].tick).toBe(1);
    const a = { ...note(60, 0), end: 0.25 };
    const evs2 = events([a, note(60, 0.25)]);
    const at = evs2.filter((e) => e.tick === ticks(0.25) && (e.type === 0x80 || e.type === 0x90)).map((e) => e.type);
    expect(at).toEqual([0x80, 0x90]);
  });
});
