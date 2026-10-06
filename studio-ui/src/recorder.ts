import { concat, encodeWavFloat32 } from "./wav";

/** Worklet that downmixes the mic to mono and posts each block. */
const TAP = `class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const n = chans[0].length;
      const mono = new Float32Array(n);
      for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i] / chans.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor("tap", Tap);`;

const pad = (n: number) => String(n).padStart(2, "0");
export const defaultTakeName = (d: Date) =>
  `take-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** A stored take name (a safe file name, "Take-1.wav") shown the way a person wrote it
 * ("Take 1"): no extension, spaces for the dashes, a capital first. */
export function takeLabel(stored: string): string {
  const s = stored.replace(/\.wav$/i, "").replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : stored;
}

/** The next take's name, as a person would write it: "Take 1", "Take 2", the lowest number
 * no take already has (any case). */
export function nextTakeName(existing: string[]): string {
  const used = new Set(existing.map((n) => /^take (\d+)$/i.exec(n.trim())?.[1]).filter(Boolean).map(Number));
  let n = 1;
  while (used.has(n)) n++;
  return `Take ${n}`;
}

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];

  get active() { return this.ctx !== null; }

  async start(onLevel: (peak: number) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    try {
      await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: "text/javascript" })));
      const src = this.ctx.createMediaStreamSource(this.stream);
      const tap = new AudioWorkletNode(this.ctx, "tap");
      const mute = this.ctx.createGain();
      mute.gain.value = 0; // keeps the graph pulling without monitoring the mic
      this.chunks = [];
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
        this.chunks.push(e.data);
        let p = 0;
        for (const s of e.data) p = Math.max(p, Math.abs(s));
        onLevel(p);
      };
      src.connect(tap).connect(mute).connect(this.ctx.destination);
    } catch (e) {
      // Never leave the mic open or report "recording" after a failed start.
      this.stream.getTracks().forEach((t) => t.stop());
      await this.ctx.close();
      this.ctx = null;
      this.stream = null;
      throw e;
    }
  }

  async stop() {
    const ctx = this.ctx!;
    this.stream?.getTracks().forEach((t) => t.stop());
    const samples = concat(this.chunks);
    const rate = ctx.sampleRate;
    await ctx.close();
    this.ctx = null;
    this.stream = null;
    return { wav: encodeWavFloat32(samples, rate), seconds: samples.length / rate };
  }
}

/** A readable reason for a getUserMedia failure. */
export function micError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError")
    return "Mic access was blocked. Allow it for this page in the browser's site settings, and for the browser in macOS System Settings > Privacy & Security > Microphone.";
  if (name === "NotFoundError") return "No microphone found. Plug one in, or open a WAV instead.";
  return `Could not start recording: ${(e as Error)?.message ?? e}`;
}

/** Name an opened file's take after the file, without its extension. */
export const takeNameFromFile = (fileName: string) => fileName.replace(/\.wav$/i, "");
