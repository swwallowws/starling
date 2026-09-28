// A small Standard MIDI File reader: enough to check what the writers made
// (tests, and the scratch export check).

export interface MidiEvent {
  tick: number;
  /** 0-based channel, or -1 for meta events. */
  channel: number;
  /** Status high nibble (0x80 note-off, 0x90 note-on, 0xb0 CC, 0xe0 bend), or 0xff for meta. */
  type: number;
  data: number[];
}

export interface MidiFile {
  format: number;
  ticksPerBeat: number;
  tracks: MidiEvent[][];
}

export function readMidi(bytes: Uint8Array): MidiFile {
  let p = 0;
  const u32 = () => ((bytes[p++] << 24) | (bytes[p++] << 16) | (bytes[p++] << 8) | bytes[p++]) >>> 0;
  const u16 = () => (bytes[p++] << 8) | bytes[p++];
  const tag = () => String.fromCharCode(bytes[p++], bytes[p++], bytes[p++], bytes[p++]);
  const varLen = () => {
    let v = 0;
    for (;;) {
      const b = bytes[p++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
  };
  if (tag() !== "MThd") throw new Error("not a MIDI file");
  const hlen = u32();
  const format = u16();
  const ntracks = u16();
  const ticksPerBeat = u16();
  p = 8 + hlen;
  const tracks: MidiEvent[][] = [];
  for (let t = 0; t < ntracks; t++) {
    if (tag() !== "MTrk") throw new Error("bad track chunk");
    const end = u32() + p;
    const events: MidiEvent[] = [];
    let tick = 0;
    let status = 0;
    while (p < end) {
      tick += varLen();
      let b = bytes[p];
      if (b & 0x80) {
        status = b;
        p++;
      }
      b = status;
      if (b === 0xff) {
        const kind = bytes[p++];
        const len = varLen();
        events.push({ tick, channel: -1, type: 0xff, data: [kind, ...bytes.slice(p, p + len)] });
        p += len;
      } else if (b === 0xf0 || b === 0xf7) {
        p += varLen();
      } else {
        const type = b & 0xf0;
        const n = type === 0xc0 || type === 0xd0 ? 1 : 2;
        events.push({ tick, channel: b & 0x0f, type, data: Array.from(bytes.slice(p, p + n)) });
        p += n;
      }
    }
    tracks.push(events);
  }
  return { format, ticksPerBeat, tracks };
}

/** A pitch-bend event's 14-bit value. */
export const bendOf = (e: MidiEvent) => e.data[0] | (e.data[1] << 7);
