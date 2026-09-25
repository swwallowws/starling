// The browser build's engine (vite aliases ./backend-impl to this file in web mode).
import type { Backend } from "./backend";
import { pitchJob, studioClient } from "./web/clients";
import { workerCount } from "./web/pool";
import { openTakeStore } from "./web/take-store";
import { createWebBackend } from "./web/web-backend";

/** From the drag-out check (plan Task 1): does Chrome drag a blob: DownloadURL out? */
const CAN_DRAG_OUT = true;

const studioWorker = () => new Worker(new URL("./web/workers/studio.worker.ts", import.meta.url), { type: "module" });
const pitchWorker = () => new Worker(new URL("./web/workers/pitch.worker.ts", import.meta.url), { type: "module" });

async function loadModel(): Promise<ArrayBuffer> {
  const res = await fetch("./crepe-tiny.onnx");
  if (!res.ok) throw new Error(`could not download the pitch model (${res.status})`);
  return res.arrayBuffer();
}

const store = await openTakeStore();

export const backend: Backend = createWebBackend(
  {
    store,
    studio: studioClient(studioWorker()),
    async pitch() {
      const model = await loadModel();
      const n = workerCount(navigator.hardwareConcurrency);
      return Promise.all(Array.from({ length: n }, () => pitchJob(pitchWorker(), model)));
    },
    objectUrl: (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })),
    download(url, fileName) {
      const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
      a.click();
    },
  },
  CAN_DRAG_OUT,
);
