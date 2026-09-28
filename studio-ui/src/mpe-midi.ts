// An MPE Standard MIDI File, written in the page. The same layout as the
// engine's writer (crates/voxmpe-core/src/smf.rs): lower zone with master
// channel 1 and member channels 2-16, one note per member channel in
// rotation, the MPE Configuration Message and a ±48 bend range declared at
// the start, per-note pitch bend for the curve and CC11 for loudness.

/** One note to write: a key, its timing, and curves relative to that key. */
export interface MpeNote {
  key: number;
  /** Seconds. */
  start: number;
  end: number;
  /** 0..1 */
  velocity: number;
  /** [seconds, semitones from `key`] */
  bend: [number, number][];
  /** [seconds, 0..1] */
  amp: [number, number][];
}

export const TICKS_PER_BEAT = 480;
export const BPM = 120;
/** Per-note bend range, semitones: the MPE default for member channels. */
export const BEND_RANGE = 48;
/** Member channels 2-16 (0-based 1-15). */
export const MEMBER_CHANNELS = 15;
const CC_EXPRESSION = 11;

/** Round half away from zero, like Rust's f64::round. */
const round = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

/** Seconds to ticks at 120 BPM, in f32 steps like the engine so both writers agree. */
export const ticks = (s: number) => round(Math.fround(Math.fround(s * (BPM / 60)) * TICKS_PER_BEAT));

/** A semitone offset as a 14-bit bend value, 8192 = none, clamped to the range. */
export const bendValue = (semis: number) => Math.min(16383, Math.max(0, round(8192 + semis * (8192 / BEND_RANGE))));

/** MIDI velocity for a 0..1 attack level, as the engine scales it. */
export const velocityValue = (v: number) => Math.min(127, Math.max(1, Math.min(255, round(v * 126)) + 1));

/** The member channel (0-based) of the i-th note. */
export const memberChannel = (i: number) => 1 + (i % MEMBER_CHANNELS);

type Ev = { tick: number; order: number; bytes: number[] };

/** One RPN (MSB 0, LSB `rpn`) set to `value`, then the RPN null. */
function rpn(channel: number, param: number, value: number): number[][] {
  const cc = (c: number, v: number) => [0xb0 | channel, c, v];
  return [cc(101, 0), cc(100, param), cc(6, value), cc(38, 0), cc(101, 127), cc(100, 127)];
}

function varLen(n: number): number[] {
  const out = [n & 0x7f];
  for (n >>>= 7; n > 0; n >>>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
}

/** The file's bytes (format 0, one track). */
export function writeMpe(notes: MpeNote[]): Uint8Array<ArrayBuffer> {
  const events: Ev[] = [];
  notes.forEach((n, i) => {
    const ch = memberChannel(i);
    const on = ticks(n.start);
    const off = Math.max(ticks(n.end), on + 1);
    const at = (t: number) => Math.min(off, Math.max(on, ticks(t)));
    for (const [t, semis] of n.bend) {
      const v = bendValue(semis);
      events.push({ tick: at(t), order: 1, bytes: [0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f] });
    }
    for (const [t, a] of n.amp) {
      events.push({ tick: at(t), order: 1, bytes: [0xb0 | ch, CC_EXPRESSION, Math.min(127, Math.max(0, round(a * 127)))] });
    }
    events.push({ tick: on, order: 2, bytes: [0x90 | ch, n.key, velocityValue(n.velocity)] });
    events.push({ tick: off, order: 0, bytes: [0x80 | ch, n.key, 0] });
  });
  // Stable: note-offs before re-onsets, bends and CCs before the note-on at the same tick.
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  const tempo = Math.round(60_000_000 / BPM);
  track.push(0, 0xff, 0x51, 3, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
  // MPE Configuration Message on the master channel first (it resets member
  // bend ranges), then the bend range on every channel.
  const setup = [...rpn(0, 6, MEMBER_CHANNELS)];
  for (let ch = 0; ch < 16; ch++) setup.push(...rpn(ch, 0, BEND_RANGE));
  for (const msg of setup) track.push(0, ...msg);
  let last = 0;
  for (const e of events) {
    track.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0, 0xff, 0x2f, 0);

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, TICKS_PER_BEAT >> 8, TICKS_PER_BEAT & 0xff];
  const len = track.length;
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
  return Uint8Array.from([...header, ...trackHeader, ...track]);
}
