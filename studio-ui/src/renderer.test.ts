import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./backend";
import { createRenderer } from "./renderer";
import { DEFAULT_SETTINGS, type Rendered, type Settings } from "./types";

const done = (flags: string): Rendered => ({ notes: [], flags });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createRenderer", () => {
  it("ignores a response that arrives after a newer request", async () => {
    const resolvers: ((r: Rendered) => void)[] = [];
    const fetchRender = vi.fn(() => new Promise<Rendered>((res) => resolvers.push(res)));
    const onResult = vi.fn();
    const r = createRenderer(fetchRender, onResult, vi.fn());
    r.request(1, { ...DEFAULT_SETTINGS, hold_ms: 100 });
    r.request(1, { ...DEFAULT_SETTINGS, hold_ms: 200 });
    resolvers[1](done("new"));
    resolvers[0](done("old"));
    await tick();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].flags).toBe("new");
  });

  it("keeps slider changes but falls back to the last good tuning", async () => {
    const good: Settings = { ...DEFAULT_SETTINGS, tuning_name: "ji.scl", tuning_scl: "good" };
    const calls: Settings[] = [];
    const fetchRender = vi.fn(async (_id: number, s: Settings) => {
      calls.push(s);
      if (s.tuning_scl === "bad") throw new ApiError(400, "tuning: bad note count");
      return done("ok");
    });
    const onTuningError = vi.fn();
    const r = createRenderer(fetchRender, vi.fn(), onTuningError);
    r.request(1, good);
    await tick();
    r.request(1, { ...good, hold_ms: 250, tuning_name: "broken.scl", tuning_scl: "bad" });
    await tick(); await tick();
    expect(onTuningError).toHaveBeenCalledWith("tuning: bad note count");
    const retry = calls[calls.length - 1];
    expect(retry.hold_ms).toBe(250);
    expect(retry.tuning_scl).toBe("good");
    expect(r.lastGood().tuning_name).toBe("ji.scl");
  });
});
