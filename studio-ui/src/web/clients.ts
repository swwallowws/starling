// Promise wrappers around the two workers' message protocol.
import { ApiError } from "../backend";
import type { Format } from "../export";
import type { Preset, Rendered, Settings, TakeInfo } from "../types";
import type { PitchJob } from "./pool";

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

/** Call `method` on `worker`; engine errors become ApiError 400, as the server's would. */
function rpc(worker: Worker) {
  let next = 0;
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const w = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (!w) return;
    if (e.data.ok) w.ok(e.data.value);
    else w.fail(new ApiError(400, e.data.message));
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.fail(new Error(e.message || "the engine stopped"));
    waiting.clear();
  };
  return <T>(method: string, args: unknown[], transfer: Transferable[] = []) =>
    new Promise<T>((ok, fail) => {
      const id = next++;
      waiting.set(id, { ok, fail });
      worker.postMessage({ id, method, args }, transfer);
    });
}

export interface StudioClient {
  load(name: string, wav: ArrayBuffer): Promise<{ audio16: Float32Array; active: Uint32Array }>;
  finish(results: Float32Array): Promise<{ info: TakeInfo; frames: Float32Array }>;
  restore(name: string, wav: ArrayBuffer, frames: Float32Array): Promise<TakeInfo>;
  render(settings: Settings): Promise<Rendered>;
  exportFile(settings: Settings, format: Format): Promise<Uint8Array<ArrayBuffer>>;
  tunings(): Promise<Preset[]>;
}

export function studioClient(worker: Worker): StudioClient {
  const call = rpc(worker);
  return {
    load: (name, wav) => call("load", [name, wav.slice(0)]),
    finish: (results) => call("finish", [results]),
    restore: (name, wav, frames) => call("restore", [name, wav.slice(0), frames]),
    render: (s) => call("render", [JSON.stringify(s)]),
    exportFile: (s, f) => call("export", [JSON.stringify(s), f]),
    tunings: () => call("tunings", []),
  };
}

/** A pitch worker with the model loaded. */
export async function pitchJob(worker: Worker, model: ArrayBuffer): Promise<PitchJob> {
  const call = rpc(worker);
  await call("init", [model.slice(0)]);
  return { run: (audio16, indices) => call("run", [audio16, indices]) };
}
