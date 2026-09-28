// The studio's engine in the page: takes in IndexedDB, analysis on pitch
// workers, everything else in the studio worker.
import { ApiError, type Backend, type Progress } from "../backend";
import { MIME } from "../export";
import { liveFiles, tuningStem } from "../live-export";
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

export function createWebBackend(deps: WebDeps, canDragOut: boolean): Backend {
  let takeId = 0;
  let open: { name: string; audioUrl: string } | null = null;
  let jobs: Promise<PitchJob[]> | null = null;
  /** Opens run one at a time: the studio worker holds a single take in progress. */
  let queue: Promise<unknown> = Promise.resolve();

  /** The pitch workers; a failed start is forgotten so the next open tries again. */
  function pool(): Promise<PitchJob[]> {
    if (!jobs) {
      const started = deps.pitch();
      jobs = started;
      started.catch(() => {
        if (jobs === started) jobs = null;
      });
    }
    return jobs;
  }

  /** Stop and forget the pitch workers, so a crashed one is never reused. */
  function dropPool() {
    const old = jobs;
    jobs = null;
    old?.then((p) => p.forEach((j) => j.dispose?.()), () => {});
  }

  async function analyze(name: string, wav: ArrayBuffer, onProgress?: Progress): Promise<TakeInfo> {
    const { audio16, active } = await deps.studio.load(name, wav);
    const workers = await pool();
    let results: Float32Array;
    try {
      results = await runShares(workers, audio16, shares(active, shareCount(workers.length)), onProgress ?? (() => {}));
    } catch (e) {
      dropPool();
      throw e;
    }
    const done = await deps.studio.finish(results);
    await deps.store.setFrames(name, done.frames);
    return done.info;
  }

  async function openNow(name: string, onProgress?: Progress): Promise<LoadResp> {
    const stored = await deps.store.get(name);
    if (!stored) throw new ApiError(404, `no take named ${name}`);
    let info: TakeInfo | null = null;
    let cached = false;
    if (stored.frames) {
      try {
        info = await deps.studio.restore(name, stored.wav, stored.frames);
        cached = true;
      } catch (e) {
        // The engine refused the cache (damaged, or not from this WAV): analyze again.
        if (!(e instanceof ApiError && e.status === 400)) throw e;
      }
    }
    info ??= await analyze(name, stored.wav, onProgress);
    open = { name, audioUrl: deps.objectUrl(stored.wav, "audio/wav") };
    return { take_id: ++takeId, info, cached };
  }

  function openStored(name: string, onProgress?: Progress): Promise<LoadResp> {
    const run = queue.then(() => openNow(name, onProgress));
    queue = run.catch(() => {});
    return run;
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
      const save = (format: SavedFile["format"], file_name: string, bytes: BlobPart) => {
        const url = deps.objectUrl(bytes, MIME[format]);
        deps.download(url, file_name);
        files.push({ format, path: null, file_name, url });
      };
      let note: string | undefined;
      for (const format of formats) {
        if (format === "live") {
          // In 12-TET the Live file is the any-synth .mid again: skip it when that is saved too.
          if (!settings.tuning_scl && formats.includes("mid")) continue;
          const live = liveFiles((await deps.studio.render(settings)).notes, settings, stem);
          for (const f of live.files) save(f.kind, f.file_name, f.bytes);
          note = live.note;
          continue;
        }
        // Name the tuning when there is one, so a 53-EDO and a 12-TET save don't overwrite each other.
        const tuned = settings.tuning_scl ? `_${tuningStem(settings.tuning_name)}` : "";
        save(format, `${stem}_studio${tuned}.${format}`, await deps.studio.exportFile(settings, format));
      }
      return note ? { files, note } : { files };
    },
    reveal: async () => {},
    currentTake: async () => null,
    listTunings: () => deps.studio.tunings(),
    audioUrl: () => open?.audioUrl ?? "",
  };
}
