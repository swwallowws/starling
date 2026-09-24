import { describe, expect, it } from "vitest";
import { concat, encodeWavFloat32 } from "./wav";
import { defaultTakeName, takeNameFromFile } from "./recorder";

describe("wav", () => {
  it("writes the float WAV layout the server decodes", () => {
    const buf = encodeWavFloat32(new Float32Array([0.5, -0.25, 0]), 96000);
    const v = new DataView(buf);
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
    expect(str(0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 12);
    expect(str(8, 8)).toBe("WAVEfmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(96000);
    expect(v.getUint16(34, true)).toBe(32);
    expect(str(36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(12);
    expect(v.getFloat32(44, true)).toBe(0.5);
    expect(v.getFloat32(48, true)).toBe(-0.25);
  });
  it("concatenates chunks in order", () => {
    expect(Array.from(concat([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3]);
  });
  it("names takes by date and time", () => {
    expect(defaultTakeName(new Date(2026, 8, 24, 9, 5, 7))).toBe("take-20260924-090507");
  });
  it("names an opened file after the file, without its extension", () => {
    expect(takeNameFromFile("Song idea.WAV")).toBe("Song idea");
    expect(takeNameFromFile("verse.wav")).toBe("verse");
    expect(takeNameFromFile("noext")).toBe("noext");
  });
});
