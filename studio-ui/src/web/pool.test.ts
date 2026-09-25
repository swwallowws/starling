import { describe, expect, it } from "vitest";
import { BATCH, runShares, shares, workerCount, type PitchJob } from "./pool";

const range = (n: number) => Uint32Array.from({ length: n }, (_, i) => i * 2);

/** A job that echoes each index as its "f0" after `delay(i)` ms. */
const echo = (delay: (first: number) => number): PitchJob => ({
  run: (_a, idx) =>
    new Promise((ok) =>
      setTimeout(() => ok(Float32Array.from([...idx].flatMap((i) => [i, 1]))), delay(idx[0] ?? 0)),
    ),
});

describe("shares", () => {
  it("splits in order into whole batches, the last one shorter", () => {
    const parts = shares(range(200), 4);
    expect(parts.flatMap((p) => [...p])).toEqual([...range(200)]);
    for (const p of parts.slice(0, -1)) expect(p.length % BATCH).toBe(0);
    expect(parts.length).toBe(4);
  });
  it("never makes more shares than batches, nor empty ones", () => {
    expect(shares(range(40), 8).length).toBe(2);
    expect(shares(new Uint32Array(), 4)).toEqual([]);
  });
});

describe("runShares", () => {
  it("returns results in frame order even when shares finish out of order", async () => {
    const parts = shares(range(300), 6);
    const progress: number[] = [];
    const out = await runShares([echo((i) => 30 - i / 20), echo(() => 1)], new Float32Array(), parts, (f) => progress.push(f));
    expect([...out].filter((_, i) => i % 2 === 0)).toEqual([...range(300)]);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });
  it("finishes at once when there is nothing to analyze", async () => {
    const progress: number[] = [];
    expect((await runShares([echo(() => 1)], new Float32Array(), [], (f) => progress.push(f))).length).toBe(0);
    expect(progress).toEqual([1]);
  });
  it("fails with a message when a worker crashes, and stops handing out shares", async () => {
    let runs = 0;
    const crash: PitchJob = {
      run: async () => {
        runs++;
        throw new Error("worker died");
      },
    };
    const e = await runShares([crash], new Float32Array(), shares(range(400), 8), () => {}).catch((x) => x);
    expect(e.message).toBe("Analysis failed: worker died");
    expect(runs).toBe(1);
  });
});

describe("workerCount", () => {
  it("uses the cores, 2 to 8", () => {
    expect([workerCount(undefined), workerCount(1), workerCount(6), workerCount(16)]).toEqual([2, 2, 6, 8]);
  });
});
