import { describe, expect, it, vi } from "vitest";
import { throttleLatest } from "./throttle";

describe("throttleLatest", () => {
  it("runs at most once per interval and always runs the last call", () => {
    vi.useFakeTimers();
    const f = vi.fn();
    const t = throttleLatest(f, 33);
    t(1); t(2); t(3);
    expect(f.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(33);
    expect(f.mock.calls).toEqual([[1], [3]]);
    vi.advanceTimersByTime(100);
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
