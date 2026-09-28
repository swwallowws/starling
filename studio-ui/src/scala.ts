// Scala .scl parsing, the same rules as the engine's (crates/voxmpe/src/scala.rs
// and quantize.rs), so the page can find each note's scale step for exports.

/** A scale pinned to an anchor: degrees in cents within one period, ascending, [0] = 0 (the 1/1). */
export interface Scale {
  description: string;
  degrees: number[];
  /** Period in cents (1200 = octave, ~1902 = 3/1 tritave). */
  period: number;
}

const ratioToCents = (r: number) => 1200 * Math.log2(r);

function parsePitch(line: string): number {
  const tok = line.trim().split(/\s+/)[0] ?? "";
  if (tok.includes(".")) {
    const c = Number(tok);
    if (!Number.isFinite(c)) throw new Error(`bad cents '${tok}'`);
    return c;
  }
  const [n, d = "1"] = tok.split("/");
  const num = Number(n);
  const den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || tok === "") throw new Error(`bad ratio '${tok}'`);
  if (den === 0) throw new Error(`zero denominator in '${tok}'`);
  return ratioToCents(num / den);
}

/** Parse the text of a .scl file. Degrees come back sorted, as the engine uses them. */
export function parseScl(text: string): Scale {
  const data = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("!"));
  if (data.length < 2) throw new Error("scl needs a description line and a note count");
  const count = Number(data[1].split(/\s+/)[0]);
  if (!Number.isInteger(count) || count < 1) throw new Error(`bad note count '${data[1]}'`);
  const pitches = data.slice(2, 2 + count);
  if (pitches.length < count) throw new Error(`declared ${count} notes, found ${pitches.length}`);
  const entries = pitches.map(parsePitch);
  const period = entries[entries.length - 1];
  const degrees = [0, ...entries.slice(0, -1)].sort((a, b) => a - b);
  return { description: data[0], degrees, period };
}

/** Frequency of a fractional MIDI note, and back. */
export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

/**
 * The scale's steps, numbered from the anchor: step 0 is the 1/1 at `anchorHz`,
 * step N (N = degrees per period) is the 1/1 a period up, negative steps go down.
 */
export class Steps {
  readonly n: number;
  constructor(readonly scale: Scale, readonly anchorHz: number) {
    this.n = scale.degrees.length;
  }

  /** Cents of step `s` above the anchor. */
  cents(s: number): number {
    const k = Math.floor(s / this.n);
    return k * this.scale.period + this.scale.degrees[s - k * this.n];
  }

  /** Step `s` as a fractional MIDI note. */
  midi(s: number): number {
    return hzToMidi(this.anchorHz * 2 ** (this.cents(s) / 1200));
  }

  /** The step a fractional MIDI pitch snaps to: the engine's Tuning::snap_freq, as a step. */
  snap(midiPitch: number): number {
    const { degrees, period } = this.scale;
    const cents = 1200 * Math.log2(midiToHz(midiPitch) / this.anchorHz);
    const k = Math.floor(cents / period);
    const reduced = cents - k * period;
    let best = 0;
    let bestErr = Math.abs(degrees[0] - reduced);
    degrees.forEach((d, j) => {
      const err = Math.abs(d - reduced);
      if (err < bestErr) {
        bestErr = err;
        best = j;
      }
    });
    // The next period's 1/1 is a candidate too, for a pitch just below the top of the period.
    if (Math.abs(period - reduced) < bestErr) return (k + 1) * this.n;
    return k * this.n + best;
  }
}
