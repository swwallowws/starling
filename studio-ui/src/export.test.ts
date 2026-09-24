import { describe, expect, it } from "vitest";
import { downloadUrlData, loadFormats, nextFormats, saveFormats, settingsKey } from "./export";
import { DEFAULT_SETTINGS } from "./types";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  };
}

const throwing = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
} as unknown as Storage;

describe("export", () => {
  it("builds Chrome's DownloadURL value per format", () => {
    expect(downloadUrlData("mid", "take1_studio.mid", "http://127.0.0.1:7878")).toBe(
      "audio/midi:take1_studio.mid:http://127.0.0.1:7878/api/exported.mid",
    );
    expect(downloadUrlData("als", "take1_studio.als", "http://127.0.0.1:7878")).toBe(
      "application/octet-stream:take1_studio.als:http://127.0.0.1:7878/api/exported.als",
    );
  });
  it("settings changes make a saved export stale", () => {
    expect(settingsKey(DEFAULT_SETTINGS)).not.toBe(settingsKey({ ...DEFAULT_SETTINGS, hold_ms: 91 }));
    expect(settingsKey(DEFAULT_SETTINGS)).toBe(settingsKey({ ...DEFAULT_SETTINGS }));
  });
});

describe("formats", () => {
  it("ticks and unticks, in a fixed order", () => {
    expect(nextFormats(["mid"], "als", true)).toEqual(["mid", "als"]);
    expect(nextFormats(["als"], "mid", true)).toEqual(["mid", "als"]);
    expect(nextFormats(["mid", "als"], "mid", false)).toEqual(["als"]);
  });
  it("keeps at least one format", () => {
    expect(nextFormats(["als"], "als", false)).toEqual(["als"]);
  });
  it("defaults to .mid and remembers the choice", () => {
    const s = memory();
    expect(loadFormats(s)).toEqual(["mid"]);
    saveFormats(s, ["als"]);
    expect(loadFormats(s)).toEqual(["als"]);
  });
  it("ignores unreadable or junk storage", () => {
    expect(loadFormats(throwing)).toEqual(["mid"]);
    expect(() => saveFormats(throwing, ["als"])).not.toThrow();
    const s = memory();
    s.setItem("voxmpe.formats", "[\"wav\"]");
    expect(loadFormats(s)).toEqual(["mid"]);
    s.setItem("voxmpe.formats", "{");
    expect(loadFormats(s)).toEqual(["mid"]);
  });
});
