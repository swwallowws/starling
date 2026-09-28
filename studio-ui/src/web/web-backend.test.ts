import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../backend";
import type { StudioClient } from "./clients";
import { createWebBackend, type WebDeps } from "./web-backend";
import { openTakeStore } from "./take-store";
import { DEFAULT_SETTINGS, type TakeInfo } from "../types";

const info = (name: string): TakeInfo => ({ name, duration_s: 1, hop_s: 0.01, contour: [], loudness: [], warning: null });

function fakeStudio(): StudioClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load: async (name) => (calls.push(`load ${name}`), { audio16: new Float32Array(10), active: Uint32Array.from([0, 1, 2]) }),
    finish: async (r) => (calls.push(`finish ${r.length}`), { info: info("a.wav"), frames: new Float32Array([0.01, 9]) }),
    restore: async (name) => (calls.push(`restore ${name}`), info(name)),
    render: async () => ({ notes: [], flags: "" }),
    exportFile: async (_s, f) => (calls.push(`export ${f}`), new Uint8Array([f === "mid" ? 1 : 2])),
    tunings: async () => [],
  };
}

async function setup() {
  const studio = fakeStudio();
  const downloads: string[] = [];
  const deps: WebDeps = {
    store: await openTakeStore(new IDBFactory()),
    studio,
    pitch: vi.fn(async () => [{ run: async (_a: Float32Array, idx: Uint32Array) => new Float32Array(idx.length * 2) }]),
    objectUrl: (_b, type) => `blob:${type}`,
    download: (_u, name) => downloads.push(name),
  };
  return { backend: createWebBackend(deps, true), studio, deps, downloads };
}

describe("web backend", () => {
  it("analyzes a new take across the pitch workers and caches the result", async () => {
    const { backend, studio, deps } = await setup();
    const progress: number[] = [];
    const r = await backend.uploadTake("a", new ArrayBuffer(8), (f) => progress.push(f));
    expect(r.info.name).toBe("a.wav");
    expect(r.cached).toBe(false);
    expect(studio.calls).toEqual(["load a.wav", "finish 6"]);
    expect(progress.at(-1)).toBe(1);
    expect(Array.from((await deps.store.get("a.wav"))!.frames!)).toEqual([0.01, 9].map(Math.fround));
    expect(await backend.listTakes()).toEqual(["a.wav"]);
    expect(backend.audioUrl()).toBe("blob:audio/wav");
  });

  it("reopens a cached take without analysis", async () => {
    const { backend, studio, deps } = await setup();
    await backend.uploadTake("a", new ArrayBuffer(8));
    const r = await backend.openTake("a.wav");
    expect(r.cached).toBe(true);
    expect(studio.calls.at(-1)).toBe("restore a.wav");
    expect(deps.pitch).toHaveBeenCalledTimes(1);
    expect(r.take_id).toBeGreaterThan(0);
  });

  it("saves each ticked format as a download with a drag URL", async () => {
    const { backend, downloads } = await setup();
    const { take_id } = await backend.uploadTake("a", new ArrayBuffer(8));
    const r = await backend.exportFiles(take_id, DEFAULT_SETTINGS, ["mid", "als"]);
    expect(downloads).toEqual(["a_studio.mid", "a_studio.als"]);
    expect(r.files.map((f) => [f.format, f.path, f.url])).toEqual([
      ["mid", null, "blob:audio/midi"],
      ["als", null, "blob:application/octet-stream"],
    ]);
  });

  it("makes the Live 12 pair in the page: a .mid and the tuning's .ascl", async () => {
    const { backend, downloads, studio } = await setup();
    studio.render = async () => ({
      notes: [{ pitch: 62, center: 62.04, start: 0, end: 0.5, velocity: 0.8, cause: "gap", bend: [[0, 0.04]], amp: [] }],
      flags: "",
    });
    const { take_id } = await backend.uploadTake("a", new ArrayBuffer(8));
    const scl = "53-EDO\n 53\n" + Array.from({ length: 52 }, (_, i) => ` ${(((i + 1) * 1200) / 53).toFixed(4)}`).join("\n") + "\n 2/1\n";
    const r = await backend.exportFiles(take_id, { ...DEFAULT_SETTINGS, tuning_name: "53-edo", tuning_scl: scl }, ["mid", "live"]);
    expect(downloads).toEqual(["a_studio_53-edo.mid", "a_live12_53-edo.mid", "53-edo.ascl"]);
    expect(r.files.map((f) => f.format)).toEqual(["mid", "mid", "ascl"]);
    expect(r.note).toContain("load 53-edo.ascl");
    expect(studio.calls.filter((c) => c.startsWith("export"))).toEqual(["export mid"]);
  });

  it("names the tuning in the studio files, so a 53-EDO and a 12-TET save don't collide", async () => {
    const { backend, downloads } = await setup();
    const { take_id } = await backend.uploadTake("a", new ArrayBuffer(8));
    const scl = "53-EDO\n 53\n" + Array.from({ length: 52 }, (_, i) => ` ${(((i + 1) * 1200) / 53).toFixed(4)}`).join("\n") + "\n 2/1\n";
    await backend.exportFiles(take_id, { ...DEFAULT_SETTINGS, tuning_name: "53-edo", tuning_scl: scl }, ["mid", "als"]);
    await backend.exportFiles(take_id, DEFAULT_SETTINGS, ["als"]);
    expect(downloads).toEqual(["a_studio_53-edo.mid", "a_studio_53-edo.als", "a_studio.als"]);
  });

  it("in 12-TET skips the Live .mid when the any-synth .mid is saved too", async () => {
    const { backend, downloads } = await setup();
    const { take_id } = await backend.uploadTake("a", new ArrayBuffer(8));
    await backend.exportFiles(take_id, DEFAULT_SETTINGS, ["mid", "live"]);
    expect(downloads).toEqual(["a_studio.mid"]);
    await backend.exportFiles(take_id, DEFAULT_SETTINGS, ["live"]);
    expect(downloads.at(-1)).toBe("a_live12.mid");
  });

  it("rejects work on a take that is no longer open, like the server's 409", async () => {
    const { backend } = await setup();
    const { take_id } = await backend.uploadTake("a", new ArrayBuffer(8));
    await backend.uploadTake("b", new ArrayBuffer(8));
    const e = await backend.render(take_id, DEFAULT_SETTINGS).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
  });

  it("engine errors become ApiError 400 and a failed analysis caches nothing", async () => {
    const { backend, deps } = await setup();
    deps.studio.load = async () => {
      throw new ApiError(400, "this take is 11 minutes long; the browser studio takes up to 10 minutes");
    };
    const e = await backend.uploadTake("long", new ArrayBuffer(8)).catch((x) => x);
    expect(e.status).toBe(400);
    expect(e.message).toContain("10 minutes");
    expect((await deps.store.get("long.wav"))!.frames).toBeNull();
  });

  it("re-analyzes a take whose cache the engine refuses", async () => {
    const { backend, studio } = await setup();
    await backend.uploadTake("a", new ArrayBuffer(8));
    studio.restore = async () => {
      throw new ApiError(400, "analysis cache does not match this take");
    };
    const r = await backend.openTake("a.wav");
    expect(r.cached).toBe(false);
    expect(studio.calls.slice(-2)).toEqual(["load a.wav", "finish 6"]);
  });

  it("tries starting the pitch workers again after a failed start", async () => {
    const { backend, deps } = await setup();
    const works = deps.pitch;
    let first = true;
    deps.pitch = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error("could not download the pitch model (503)");
      }
      return works();
    });
    const e = await backend.uploadTake("a", new ArrayBuffer(8)).catch((x) => x);
    expect(e.message).toContain("pitch model");
    expect((await backend.openTake("a.wav")).info.name).toBe("a.wav");
    expect(deps.pitch).toHaveBeenCalledTimes(2);
  });

  it("replaces the pitch workers after one crashes", async () => {
    const { backend, deps } = await setup();
    const disposed: number[] = [];
    let pools = 0;
    deps.pitch = vi.fn(async () => {
      const k = ++pools;
      return [
        {
          run: async (_a: Float32Array, idx: Uint32Array) => {
            if (k === 1) throw new Error("worker died");
            return new Float32Array(idx.length * 2);
          },
          dispose: () => disposed.push(k),
        },
      ];
    });
    const e = await backend.uploadTake("a", new ArrayBuffer(8)).catch((x) => x);
    expect(e.message).toContain("worker died");
    expect(disposed).toEqual([1]);
    expect((await backend.openTake("a.wav")).cached).toBe(false);
    expect(deps.pitch).toHaveBeenCalledTimes(2);
  });

  it("runs one open at a time", async () => {
    const { backend, studio } = await setup();
    // A slow first load, so a second open would overlap it without a queue.
    const load = studio.load;
    studio.load = async (name, wav) => {
      if (name === "a.wav") await new Promise((r) => setTimeout(r, 20));
      return load(name, wav);
    };
    const [a, b] = await Promise.all([
      backend.uploadTake("a", new ArrayBuffer(8)),
      backend.uploadTake("b", new ArrayBuffer(8)),
    ]);
    expect(studio.calls).toEqual(["load a.wav", "finish 6", "load b.wav", "finish 6"]);
    expect(b.take_id).toBeGreaterThan(a.take_id);
  });

  it("deletes takes and declares its abilities", async () => {
    const { backend } = await setup();
    await backend.uploadTake("a", new ArrayBuffer(8));
    await backend.deleteTake("a.wav");
    expect(await backend.listTakes()).toEqual([]);
    expect([backend.kind, backend.canReveal, backend.canDelete, backend.canDragOut]).toEqual(["web", false, true, true]);
    expect(await backend.currentTake()).toBeNull();
  });
});
