// Sampled playback of the notes, as MIDI for a General MIDI synth: every note on its own channel
// (round-robin over 15, channel 10 left to the drums), like MPE. The pitch curve rides the pitch
// wheel at a ±48 bend range (0.6 cent per step, so 53-EDO steps and glides land), the loudness
// curve rides CC11 (expression). Events are handed to the synth a short while ahead, timed in
// AudioContext seconds, so the synth places them itself and timer jitter never reaches the sound.
import { noteAutomation, type Automation } from "./synth";
import { BEND_RANGE, bendValue } from "./mpe-midi";
import type { RNote } from "./types";

export { BEND_RANGE };

/** The channels a note can take (0-based): all but 9, the GM drum channel. */
export const CHANNELS = Array.from({ length: 16 }, (_, i) => i).filter((c) => c !== 9);

/** What the scheduler asks of the synth. `time` is AudioContext seconds; 0 = now. */
export interface SynthPort {
  bend(ch: number, value: number, time: number): void;
  cc(ch: number, cc: number, value: number, time: number): void;
  on(ch: number, key: number, velocity: number, time: number): void;
  off(ch: number, key: number, time: number): void;
}

export type NoteEvent =
  | { t: number; kind: "bend"; value: number }
  | { t: number; kind: "expr"; value: number }
  | { t: number; kind: "on"; key: number }
  | { t: number; kind: "off"; key: number };

/** Pitch wheel updates at most this often (s): below the synth's own ~3 ms block, so glides are smooth. */
export const BEND_STEP = 0.004;
/** Expression updates at most this often (s). */
export const EXPR_STEP = 0.01;
/** One fixed velocity: loudness comes from CC11, so every note has the same timbre. */
export const VELOCITY = 100;
/** How long a channel stays reserved after its note ends, for the sample's release. */
export const RELEASE = 0.8;
/** CC7 (channel volume) as General MIDI sets it at reset. */
export const VOLUME = 100;
/** The peak gain in noteAutomation, so a gain point maps back to the 0..1 amplitude. */
const LEVEL = 0.25;

const CC_VOLUME = 7;
const CC_EXPRESSION = 11;
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;

/** Semitones above MIDI note 0 for a frequency. */
const semis = (hz: number) => 69 + 12 * Math.log2(hz / 440);

/** CC11 for a 0..1 amplitude: SoundFont synths apply CC11 as a squared (concave) gain, so the
 * square root keeps the sounding amplitude proportional to the curve. */
export const exprValue = (amp: number) => Math.round(127 * Math.sqrt(Math.min(1, Math.max(0, amp))));

/** Linear interpolation over [t, v] points, held flat outside them. */
function valueAt(points: [number, number][], t: number): number {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
}

/** Sample a curve every `step` seconds over [start, end), keeping a value only when it changes. */
function sampled(points: [number, number][], start: number, end: number, step: number, value: (x: number) => number) {
  const out: [number, number][] = [];
  let last = NaN;
  const times = new Set<number>();
  for (let t = start; t < end; t += step) times.add(t);
  for (const [t] of points) if (t > start && t < end) times.add(t);
  for (const t of [...times].sort((a, b) => a - b)) {
    const v = value(valueAt(points, t));
    if (v !== last) out.push([t, v]);
    last = v;
  }
  return out;
}

/** A note's events (song seconds) from `from` on, or [] once it has ended. The pitch comes from
 * the same automation the roll's pitch line uses, relative to the note's MIDI key. */
export function noteEvents(n: RNote, from = -Infinity): NoteEvent[] {
  const a: Automation = noteAutomation(n);
  // Cut at the playhead by interpolating the whole curve there, so a note joined mid-glide
  // starts at the glide's pitch at that moment.
  const start = Math.max(a.start, from);
  if (a.end <= start) return [];
  const key = n.pitch;
  const freq = a.freq.map(([t, hz]) => [t, semis(hz) - key] as [number, number]);
  const gain = a.gain.map(([t, g]) => [t, g / LEVEL] as [number, number]);
  const bends = sampled(freq, start, a.end, BEND_STEP, bendValue);
  const exprs = sampled(gain, start, a.end, EXPR_STEP, exprValue);
  const ev: NoteEvent[] = [];
  // Wheel and expression first, then the note-on at the same moment, so it starts in tune.
  ev.push({ t: start, kind: "bend", value: bends[0][1] }, { t: start, kind: "expr", value: exprs[0][1] });
  ev.push({ t: start, kind: "on", key });
  for (const [t, value] of bends.slice(1)) ev.push({ t, kind: "bend", value });
  for (const [t, value] of exprs.slice(1)) ev.push({ t, kind: "expr", value });
  ev.push({ t: a.end, kind: "off", key });
  // Stable, so equal times keep the order above.
  return ev.sort((x, y) => x.t - y.t);
}

interface Live { ch: number; events: NoteEvent[]; next: number; }

/** Plays one run of notes from a playhead; `cancel` ends it at once, whatever the synth still
 * holds queued. Channel reservations outlive a run, so a new run never shares a channel with
 * events an older one left in the synth's queue. */
export class Scheduler {
  /** AudioContext time until which each channel is taken. */
  private busy = new Map<number, number>();
  private pending: RNote[] = [];
  private live: Live[] = [];
  private used = new Set<number>();
  /** The latest time handed to the synth in this run. */
  private sentUntil = 0;
  private from = 0;
  private startedAt = 0;
  running = false;

  constructor(private port: SynthPort) {}

  /** Start a run: song time `from` sounds at AudioContext time `startedAt`. */
  start(notes: RNote[], from: number, startedAt: number) {
    this.pending = notes.filter((n) => n.end > from).sort((a, b) => a.start - b.start);
    this.live = [];
    this.used.clear();
    this.from = from;
    this.startedAt = startedAt;
    this.sentUntil = startedAt;
    this.running = true;
  }

  private ctxTime(t: number) { return this.startedAt + (t - this.from); }

  /** Hand the synth everything up to `ahead` seconds past `now` (AudioContext time). */
  pump(now: number, ahead: number) {
    if (!this.running) return;
    const songNow = this.from + (now - this.startedAt);
    const horizon = songNow + ahead;
    while (this.pending.length && this.pending[0].start <= horizon) {
      const n = this.pending.shift()!;
      const events = noteEvents(n, Math.max(this.from, songNow));
      if (!events.length) continue;
      const ch = this.channel();
      this.busy.set(ch, this.ctxTime(events[events.length - 1].t) + RELEASE);
      this.used.add(ch);
      this.live.push({ ch, events, next: 0 });
    }
    for (const v of this.live) {
      for (; v.next < v.events.length && v.events[v.next].t <= horizon; v.next++) {
        const e = v.events[v.next];
        const at = Math.max(this.ctxTime(e.t), now);
        this.sentUntil = Math.max(this.sentUntil, at);
        if (e.kind === "bend") this.port.bend(v.ch, e.value, at);
        else if (e.kind === "expr") this.port.cc(v.ch, CC_EXPRESSION, e.value, at);
        else if (e.kind === "on") this.port.on(v.ch, e.key, VELOCITY, at);
        else this.port.off(v.ch, e.key, at);
      }
    }
    this.live = this.live.filter((v) => v.next < v.events.length);
  }

  /** The channel for the next note: the one free the longest (or, if none is free, freed soonest). */
  private channel(): number {
    let best = CHANNELS[0];
    for (const c of CHANNELS) if ((this.busy.get(c) ?? 0) < (this.busy.get(best) ?? 0)) best = c;
    return best;
  }

  /** Silence this run now. Its channels go quiet at once (volume 0, notes off), and a reset is
   * queued just after the last event it sent, where it clears whatever of the run is still
   * waiting in the synth and brings the volume back; until then those channels stay taken. */
  cancel(now: number) {
    if (!this.running) return;
    this.running = false;
    const clearAt = Math.max(this.sentUntil, now) + 0.003;
    for (const ch of this.used) {
      if ((this.busy.get(ch) ?? 0) <= now) continue;
      this.port.cc(ch, CC_VOLUME, 0, 0);
      this.port.cc(ch, CC_ALL_NOTES_OFF, 0, 0);
      this.port.cc(ch, CC_ALL_SOUND_OFF, 0, clearAt);
      this.port.cc(ch, CC_VOLUME, VOLUME, clearAt);
      this.busy.set(ch, clearAt + 0.005);
    }
    this.pending = [];
    this.live = [];
    this.used.clear();
  }
}
