// One CREPE tiny model; runs shares of frames for the page.
import init, { PitchWorker } from "../../wasm-pkg/voxmpe_web.js";

let model: PitchWorker | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; method: string; args: any[] }>) => {
  const { id, method, args } = e.data;
  try {
    if (method === "init") {
      await init();
      model = new PitchWorker(new Uint8Array(args[0]));
      self.postMessage({ id, ok: true, value: null });
    } else if (method === "run") {
      const out = model!.run(args[0], args[1]);
      self.postMessage({ id, ok: true, value: out }, { transfer: [out.buffer] });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, message: (err as Error).message });
  }
};
