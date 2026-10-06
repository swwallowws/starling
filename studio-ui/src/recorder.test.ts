import { afterEach, describe, expect, it, vi } from "vitest";
import { Recorder, nextTakeName, takeLabel } from "./recorder";

afterEach(() => vi.unstubAllGlobals());

describe("nextTakeName", () => {
  it("names takes like a person would: Take 1, Take 2, the first number not taken", () => {
    expect(nextTakeName([])).toBe("Take 1");
    expect(nextTakeName(["Take 1", "starling.wav"])).toBe("Take 2");
    expect(nextTakeName(["Take 1", "Take 3"])).toBe("Take 2");
    expect(nextTakeName(["take 1"])).toBe("Take 2");
  });

  it("counts takes by their shown names, so stored file names work too", () => {
    expect(nextTakeName(["Take-1.wav", "Take-2.wav"].map(takeLabel))).toBe("Take 3");
  });
});

describe("takeLabel", () => {
  it("shows a stored take name the way a person wrote it", () => {
    expect(takeLabel("Take-1.wav")).toBe("Take 1");
    expect(takeLabel("Starling-song.wav")).toBe("Starling song");
    expect(takeLabel("starling.wav")).toBe("Starling");
    expect(takeLabel("my_take-2.wav")).toBe("My take 2");
  });
});

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
