// The browser build's engine (vite aliases ./backend-impl to this file in web mode).
// Importing it starts nothing: the take store and the studio worker are made on
// first use, so the page can check browser support first.
import type { Backend } from "./backend";
import { pitchJob, studioClient, type StudioClient } from "./web/clients";
import { lazy } from "./web/lazy";
import { workerCount } from "./web/pool";
import { openTakeStore, type TakeStore } from "./web/take-store";
import { createWebBackend } from "./web/web-backend";

/** Chrome does not drag a blob: DownloadURL out of the page (checked 2026-09-25),
 *  so the browser build saves by download only. */
const CAN_DRAG_OUT = false;

const studioWorker = () => new Worker(new URL("./web/workers/studio.worker.ts", import.meta.url), { type: "module" });
const pitchWorker = () => new Worker(new URL("./web/workers/pitch.worker.ts", import.meta.url), { type: "module" });

async function loadModel(): Promise<ArrayBuffer> {
  const res = await fetch("./crepe-tiny.onnx");
  if (!res.ok) throw new Error(`could not download the pitch model (${res.status})`);
  return res.arrayBuffer();
}

export const backend: Backend = createWebBackend(
  {
    store: lazy<TakeStore>(() => openTakeStore()),
    studio: lazy<StudioClient>(() => studioClient(studioWorker())),
    async pitch() {
      const model = await loadModel();
      const workers = Array.from({ length: workerCount(navigator.hardwareConcurrency) }, pitchWorker);
      try {
        return await Promise.all(workers.map((w) => pitchJob(w, model)));
      } catch (e) {
        for (const w of workers) w.terminate();
        throw e;
      }
    },
    objectUrl: (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })),
    download(url, fileName) {
      const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
      a.click();
    },
  },
  CAN_DRAG_OUT,
);
