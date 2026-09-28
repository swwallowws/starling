// The try page's sample take: a starling's song, shipped as a small MP3
// (studio-ui/samples, made by scripts/make-sample.mjs). The browser decodes
// it and the engine gets a WAV, the same as a recorded take.
import { encodeWavFloat32 } from "../wav";

/** The take's name in the browser's take list. The button label and the
 *  credit ("Starling song: Vrymaa, Freesound, CC0") are in try/index.html. */
export const SAMPLE_NAME = "starling-song";

/** The decoded audio, as an AudioBuffer gives it. */
export interface Decoded {
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Average the channels into one. */
export function downmix(d: Decoded): Float32Array {
  const n = d.numberOfChannels;
  if (n === 1) return d.getChannelData(0);
  const out = new Float32Array(d.getChannelData(0).length);
  for (let c = 0; c < n; c++) {
    const ch = d.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / n;
  }
  return out;
}

/** Fetch the sample and turn it into a mono float WAV for uploadTake. */
export async function sampleWav(
  url: string | URL,
  decode: (bytes: ArrayBuffer) => Promise<Decoded>,
  get: typeof fetch = fetch,
): Promise<{ wav: ArrayBuffer; seconds: number }> {
  const res = await get(url);
  if (!res.ok) throw new Error(`The starling's song didn't load (${res.status}). Try again in a moment.`);
  const decoded = await decode(await res.arrayBuffer());
  const mono = downmix(decoded);
  return { wav: encodeWavFloat32(mono, decoded.sampleRate), seconds: mono.length / decoded.sampleRate };
}

/** decodeAudioData on an offline context, so nothing starts sounding. */
export function browserDecode(bytes: ArrayBuffer): Promise<Decoded> {
  return new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes);
}
