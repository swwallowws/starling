import { describe, it, expect } from "vitest";
import { downmix, sampleWav, type Decoded } from "./sample";

const decoded = (rate: number, ...chans: number[][]): Decoded => ({
  sampleRate: rate,
  numberOfChannels: chans.length,
  getChannelData: (c) => Float32Array.from(chans[c]),
});

describe("try sample take", () => {
  it("averages channels into one", () => {
    expect([...downmix(decoded(8000, [1, 0.5], [0, -0.5]))]).toEqual([0.5, 0]);
    expect([...downmix(decoded(8000, [0.25, -0.25]))]).toEqual([0.25, -0.25]);
  });

  it("fetches, decodes and hands the engine a mono float WAV", async () => {
    const seen: string[] = [];
    const get = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const { wav, seconds } = await sampleWav("s.mp3", async (b) => {
      expect(b.byteLength).toBe(3);
      return decoded(4, [0, 0.5, -0.5, 1, 0, 0, 0, 0], [0, 0.5, -0.5, 1, 0, 0, 0, 0]);
    }, get);
    expect(seen).toEqual(["s.mp3"]);
    expect(seconds).toBe(2);
    const v = new DataView(wav);
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe("RIFF");
    expect(v.getUint16(20, true)).toBe(3); // float
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(4);
    expect(v.getFloat32(44 + 3 * 4, true)).toBe(1);
  });

  it("says so when the file doesn't load", async () => {
    const get = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(sampleWav("s.mp3", async () => decoded(1, [0]), get)).rejects.toThrow(/didn't load \(404\)/);
  });
});
