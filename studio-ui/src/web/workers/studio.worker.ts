// The open take: decode, assemble, render and export, all in this worker.
import init, { Studio, tunings } from "../../wasm-pkg/voxmpe_web.js";

const ready = init();
let studio: Studio | null = null;

const methods: Record<string, (...a: any[]) => unknown> = {
  load(name: string, wav: ArrayBuffer) {
    studio = new Studio();
    studio.load(name, new Uint8Array(wav));
    return { audio16: studio.audio16(), active: studio.active() };
  },
  finish(results: Float32Array) {
    const info = JSON.parse(studio!.finish(results));
    return { info, frames: studio!.frames() };
  },
  restore(name: string, wav: ArrayBuffer, frames: Float32Array) {
    studio = new Studio();
    return JSON.parse(studio.restore(name, new Uint8Array(wav), frames));
  },
  render: (settings: string) => JSON.parse(studio!.render(settings)),
  export: (settings: string, format: string) => studio!.export(settings, format),
  tunings: () => JSON.parse(tunings()),
};

self.onmessage = async (e: MessageEvent<{ id: number; method: string; args: any[] }>) => {
  const { id, method, args } = e.data;
  try {
    await ready;
    if (!studio && method !== "load" && method !== "restore" && method !== "tunings") throw new Error("no take is open");
    self.postMessage({ id, ok: true, value: methods[method](...args) });
  } catch (err) {
    self.postMessage({ id, ok: false, message: (err as Error).message });
  }
};
