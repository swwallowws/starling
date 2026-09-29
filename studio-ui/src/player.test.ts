import { afterEach, describe, expect, it, vi } from "vitest";
import { Player } from "./player";

class FakeParam {
  value = 1;
}

class FakeNode {
  connect(): this {
    return this;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  destination = new FakeNode();
  sources: FakeBufferSource[] = [];
  decodeAudioData = vi.fn(async () => ({ duration: 2 }));
  resume = vi.fn(async () => {});
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  createAnalyser() {
    return Object.assign(new FakeNode(), { fftSize: 32, getFloatTimeDomainData: vi.fn() });
  }
}

/** Builds a Player over a fake AudioContext, with a take already loaded. */
async function makePlayer(): Promise<{ player: Player; ctx: FakeAudioContext }> {
  let ctx!: FakeAudioContext;
  vi.stubGlobal(
    "AudioContext",
    class extends FakeAudioContext {
      constructor() {
        super();
        ctx = this;
      }
    },
  );
  vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })));
  // The fake has no AudioWorklet, so the instruments never load; the voice is what's tested here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const player = new Player();
  await player.load("take.wav");
  return { player, ctx };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Player", () => {
  it("stops on the source's natural end even if the audio clock reports a position just short of the buffer duration", async () => {
    const { player, ctx } = await makePlayer();
    player.play(0);
    const source = ctx.sources[0];
    // A small audio-clock lag: onended has fired, but position() reads a hair under the buffer's 2s duration.
    ctx.currentTime = 1.95;
    source.onended?.();
    expect(player.playing).toBe(false);
  });

  it("ignores a stale onended from a source replaced by a seek", async () => {
    const { player, ctx } = await makePlayer();
    player.play(0);
    const first = ctx.sources[0];
    ctx.currentTime = 0.5;
    player.play(1); // seeking stops the first source and starts a second one
    expect(ctx.sources).toHaveLength(2);
    expect(player.playing).toBe(true);
    // The browser delivers the old source's onended after the seek already started a new one.
    first.onended?.();
    expect(player.playing).toBe(true);
  });

  it("stays stopped when onended fires after an explicit stop", async () => {
    const { player, ctx } = await makePlayer();
    player.play(0);
    const source = ctx.sources[0];
    player.stop();
    expect(player.playing).toBe(false);
    source.onended?.();
    expect(player.playing).toBe(false);
  });
});
