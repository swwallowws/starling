import { afterEach, describe, expect, it, vi } from "vitest";
import { Recorder } from "./recorder";

afterEach(() => vi.unstubAllGlobals());

describe("Recorder", () => {
  it("releases the mic and the audio context when starting fails", async () => {
    const trackStop = vi.fn();
    const close = vi.fn(async () => {});
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule: vi.fn(async () => { throw new Error("worklet failed"); }) };
        close = close;
      },
    );
    const r = new Recorder();
    await expect(r.start(() => {})).rejects.toThrow("worklet failed");
    expect(trackStop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(r.active).toBe(false);
  });
});
