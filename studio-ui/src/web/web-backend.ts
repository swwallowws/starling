// The studio's engine in the page: takes in IndexedDB, analysis on pitch
// workers, everything else in the studio worker.
import { ApiError, type Backend, type Progress } from "../backend";
import type { Format } from "../export";
import type { LoadResp, SavedFile, TakeInfo } from "../types";
import type { StudioClient } from "./clients";
import { runShares, shareCount, shares, type PitchJob } from "./pool";
import type { TakeStore } from "./take-store";

export interface WebDeps {
  store: TakeStore;
  studio: StudioClient;
  /** The pitch workers, started on the first analysis and kept. */
  pitch(): Promise<PitchJob[]>;
  objectUrl(bytes: BlobPart, type: string): string;
  download(url: string, fileName: string): void;
}

const MIME: Record<Format, string> = { mid: "audio/midi", als: "application/octet-stream" };

export function createWebBackend(deps: WebDeps, canDragOut: boolean): Backend {
  let takeId = 0;
  let open: { name: string; audioUrl: string } | null = null;
  let jobs: Promise<PitchJob[]> | null = null;

  async function openStored(name: string, onProgress?: Progress): Promise<LoadResp> {
    const stored = await deps.store.get(name);
    if (!stored) throw new ApiError(404, `no take named ${name}`);
    let info: TakeInfo;
    let cached = false;
    if (stored.frames) {
      info = await deps.studio.restore(name, stored.wav, stored.frames);
      cached = true;
    } else {
      const { audio16, active } = await deps.studio.load(name, stored.wav);
      const pool = await (jobs ??= deps.pitch());
      const results = await runShares(pool, audio16, shares(active, shareCount(pool.length)), onProgress ?? (() => {}));
      const done = await deps.studio.finish(results);
      await deps.store.setFrames(name, done.frames);
      info = done.info;
    }
    open = { name, audioUrl: deps.objectUrl(stored.wav, "audio/wav") };
    return { take_id: ++takeId, info, cached };
  }

  const current = (id: number) => {
    if (!open || id !== takeId) throw new ApiError(409, "that take is no longer open");
    return open;
  };

  return {
    kind: "web",
    canReveal: false,
    canDelete: true,
    canDragOut,
    listTakes: () => deps.store.list(),
    openTake: openStored,
    async uploadTake(name, wav, onProgress) {
      return openStored(await deps.store.add(name, wav), onProgress);
    },
    deleteTake: (name) => deps.store.remove(name),
    async render(id, settings) {
      current(id);
      return deps.studio.render(settings);
    },
    async exportFiles(id, settings, formats) {
      const { name } = current(id);
      const stem = name.replace(/\.wav$/, "");
      const files: SavedFile[] = [];
      for (const format of formats) {
        const bytes = await deps.studio.exportFile(settings, format);
        const file_name = `${stem}_studio.${format}`;
        const url = deps.objectUrl(bytes, MIME[format]);
        deps.download(url, file_name);
        files.push({ format, path: null, file_name, url });
      }
      return { files };
    },
    reveal: async () => {},
    currentTake: async () => null,
    listTunings: () => deps.studio.tunings(),
    audioUrl: () => open?.audioUrl ?? "",
  };
}
