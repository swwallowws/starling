import { describe, expect, it } from "vitest";
import { downloadUrlData, settingsKey } from "./export";
import { DEFAULT_SETTINGS } from "./types";

describe("export", () => {
  it("builds Chrome's DownloadURL value", () => {
    expect(downloadUrlData("take1_studio.mid", "http://127.0.0.1:7878")).toBe(
      "audio/midi:take1_studio.mid:http://127.0.0.1:7878/api/exported.mid",
    );
  });
  it("settings changes make a saved export stale", () => {
    expect(settingsKey(DEFAULT_SETTINGS)).not.toBe(settingsKey({ ...DEFAULT_SETTINGS, hold_ms: 91 }));
    expect(settingsKey(DEFAULT_SETTINGS)).toBe(settingsKey({ ...DEFAULT_SETTINGS }));
  });
});
