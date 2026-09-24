import type { RNote } from "./types";

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export interface Automation { start: number; end: number; freq: [number, number][]; gain: [number, number][]; }

/** Peak oscillator gain, so a few overlapping notes don't clip. */
const LEVEL = 0.25;

export function noteAutomation(n: RNote): Automation {
  const freq: [number, number][] = n.bend.length
    ? n.bend.map(([t, st]) => [t, midiToHz(n.pitch + st)])
    : [[n.start, midiToHz(n.pitch)]];
  const gain: [number, number][] = n.amp.length
    ? n.amp.map(([t, a]) => [t, LEVEL * a])
    : [[n.start, LEVEL * n.velocity]];
  return { start: n.start, end: n.end, freq, gain };
}

function clip(events: [number, number][], t: number): [number, number][] {
  const before = events.filter(([et]) => et <= t);
  const after = events.filter(([et]) => et > t);
  const carry = before.length ? before[before.length - 1][1] : after[0]?.[1];
  return carry === undefined ? after : [[t, carry], ...after];
}

export function fromTime(a: Automation, t: number): Automation | null {
  if (a.end <= t) return null;
  if (a.start >= t) return a;
  return { start: t, end: a.end, freq: clip(a.freq, t), gain: clip(a.gain, t) };
}

/** The gain a note holds just before it ends: its last amplitude event. */
export const releaseLevel = (a: Automation) => a.gain[a.gain.length - 1][1];

/** Where Play starts: from the beginning once the take has played to its end. */
export const startPoint = (from: number, duration: number) =>
  from < 0 || from >= duration - 0.05 ? 0 : from;
