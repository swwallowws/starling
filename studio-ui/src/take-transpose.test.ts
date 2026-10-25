import { describe, expect, it } from "vitest";
import { forgetTranspose, rememberTranspose, transposeFor } from "./take-transpose";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("each take's Transpose", () => {
  it("a new recording starts at 0, the starling's song (any copy) at -24", () => {
    const s = memory();
    expect(transposeFor(s, "Take 1.wav")).toBe(0);
    expect(transposeFor(s, "Starling song.wav")).toBe(-24);
    expect(transposeFor(s, "Starling song-2.wav")).toBe(-24);
  });

  it("a take keeps what it was set to, apart from the others", () => {
    const s = memory();
    rememberTranspose(s, "Take 1.wav", 5);
    rememberTranspose(s, "Starling song.wav", -12);
    expect(transposeFor(s, "Take 1.wav")).toBe(5);
    expect(transposeFor(s, "Starling song.wav")).toBe(-12);
    expect(transposeFor(s, "Take 2.wav")).toBe(0);
  });

  it("set back to 0, it stays 0, even for the starling's song", () => {
    const s = memory();
    rememberTranspose(s, "Starling song.wav", 0);
    expect(transposeFor(s, "Starling song.wav")).toBe(0);
  });

  it("a deleted take forgets its value, so a new take under its name starts fresh", () => {
    const s = memory();
    rememberTranspose(s, "Take 1.wav", 7);
    forgetTranspose(s, "Take 1.wav");
    expect(transposeFor(s, "Take 1.wav")).toBe(0);
  });

  it("broken storage just means defaults", () => {
    const s = memory();
    s.setItem("voxmpe:take-transpose", "{not json");
    expect(transposeFor(s, "Take 1.wav")).toBe(0);
  });
});
