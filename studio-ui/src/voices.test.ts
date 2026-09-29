import { describe, expect, it } from "vitest";
import { BEND_RANGE, CHANNELS, Scheduler, exprValue, noteEvents, type SynthPort } from "./voices";
import type { RNote } from "./types";

const note = (pitch: number, start: number, end: number, bend: [number, number][] = [], amp: [number, number][] = []): RNote => ({
  pitch, center: pitch, start, end, velocity: 0.8, cause: "gap", bend, amp,
});

/** The bend's semitones back from a 14-bit value. */
const semis = (v: number) => ((v - 8192) * BEND_RANGE) / 8192;

type Call = [string, ...number[]];
function recorder(): { port: SynthPort; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    port: {
      bend: (...a) => calls.push(["bend", ...a]),
      cc: (...a) => calls.push(["cc", ...a]),
      on: (...a) => calls.push(["on", ...a]),
      off: (...a) => calls.push(["off", ...a]),
    },
  };
}

describe("noteEvents", () => {
  it("sets the wheel and expression before the note-on, and ends with the note-off", () => {
    const ev = noteEvents(note(60, 1, 2, [[1, 0.5]], [[1, 1]]));
    expect(ev.slice(0, 3).map((e) => e.kind)).toEqual(["bend", "expr", "on"]);
    expect(ev.at(-1)).toEqual({ t: 2, kind: "off", key: 60 });
    expect(semis((ev[0] as { value: number }).value)).toBeCloseTo(0.5, 2);
  });

  it("follows a glide to within a cent, with no gap longer than the bend step", () => {
    // A two-semitone rise over 0.2 s.
    const ev = noteEvents(note(60, 0, 0.3, [[0, 0], [0.2, 2], [0.3, 2]]));
    const bends = ev.filter((e) => e.kind === "bend") as { t: number; value: number }[];
    for (const b of bends) {
      const want = Math.min(2, (b.t / 0.2) * 2);
      expect(Math.abs(semis(b.value) - want) * 100).toBeLessThan(1);
    }
    const inGlide = bends.filter((b) => b.t < 0.2);
    for (let i = 1; i < inGlide.length; i++) expect(inGlide[i].t - inGlide[i - 1].t).toBeLessThan(0.0045);
  });

  it("lands a 53-EDO step exactly: one comma is 22.6 cents", () => {
    const comma = 1200 / 53 / 100;
    const [first] = noteEvents(note(62, 0, 1, [[0, comma]]));
    expect(Math.abs(semis((first as { value: number }).value) - comma) * 100).toBeLessThan(0.6);
  });

  it("starts a note already sounding at the playhead, and skips one that has ended", () => {
    const n = note(64, 1, 3, [[1, 0], [3, 1]]);
    const ev = noteEvents(n, 2);
    expect(ev[0].t).toBe(2);
    expect(semis((ev[0] as { value: number }).value)).toBeCloseTo(0.5, 2);
    expect(noteEvents(n, 3)).toEqual([]);
  });

  it("maps amplitude to CC11 through its square root", () => {
    expect(exprValue(1)).toBe(127);
    expect(exprValue(0.25)).toBe(64);
    expect(exprValue(0)).toBe(0);
  });
});

describe("Scheduler", () => {
  it("never uses the drum channel and gives overlapping notes their own channels", () => {
    const { port, calls } = recorder();
    const s = new Scheduler(port);
    const notes = Array.from({ length: 20 }, (_, i) => note(60 + (i % 5), i * 0.1, i * 0.1 + 0.5));
    s.start(notes, 0, 10);
    for (let t = 10; t < 13; t += 0.025) s.pump(t, 0.25);
    const ons = calls.filter((c) => c[0] === "on");
    expect(ons).toHaveLength(20);
    expect(ons.every((c) => c[1] !== 9)).toBe(true);
    // Notes 0.1 s apart and 0.5 s long overlap five deep: no two of them share a channel.
    for (let i = 0; i + 5 < ons.length; i++) expect(new Set(ons.slice(i, i + 5).map((c) => c[1])).size).toBe(5);
    expect(CHANNELS).toHaveLength(15);
  });

  it("times events on the audio clock from the playhead", () => {
    const { port, calls } = recorder();
    const s = new Scheduler(port);
    s.start([note(60, 2, 3)], 1.5, 100);
    s.pump(100, 1);
    const on = calls.find((c) => c[0] === "on")!;
    expect(on[4]).toBeCloseTo(100.5, 6);
  });

  it("only hands over what falls inside the look-ahead", () => {
    const { port, calls } = recorder();
    const s = new Scheduler(port);
    s.start([note(60, 0, 0.1), note(62, 1, 1.1)], 0, 0);
    s.pump(0, 0.25);
    expect(calls.filter((c) => c[0] === "on")).toHaveLength(1);
  });

  it("on cancel, quiets its channels now and clears them after the last queued event", () => {
    const { port, calls } = recorder();
    const s = new Scheduler(port);
    s.start([note(60, 0, 2, [[0, 0], [2, 4]])], 0, 0); // a slow glide: bends all through the look-ahead
    s.pump(0, 0.25);
    const ch = calls.find((c) => c[0] === "on")![1];
    calls.length = 0;
    s.cancel(0.1);
    expect(calls).toContainEqual(["cc", ch, 7, 0, 0]);
    const clear = calls.find((c) => c[0] === "cc" && c[2] === 120)!;
    expect(clear[4]).toBeGreaterThan(0.25);
    expect(calls).toContainEqual(["cc", ch, 7, 100, clear[4]]);
    // A new run right away takes a different channel while the old one's queue drains.
    calls.length = 0;
    s.start([note(60, 0.1, 2)], 0.1, 0.1);
    s.pump(0.1, 0.25);
    expect(calls.find((c) => c[0] === "on")![1]).not.toBe(ch);
  });
});
