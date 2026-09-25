// Splitting a take's active frames across pitch workers and putting the
// results back in order. Pure, so it is tested without real workers.

/** Frames per model run; shares are whole batches so none is padded mid-take. */
export const BATCH = 32;
/** Shares per worker: more shares than workers keeps every worker busy and progress smooth. */
const SHARES_PER_WORKER = 4;

export interface PitchJob {
  run(audio16: Float32Array, indices: Uint32Array): Promise<Float32Array>;
}

/** Split `active` into at most `parts` contiguous shares of whole batches (the last may be shorter). */
export function shares(active: Uint32Array, parts: number): Uint32Array[] {
  const batches = Math.ceil(active.length / BATCH);
  if (!batches) return [];
  const per = Math.ceil(batches / Math.max(1, Math.min(parts, batches))) * BATCH;
  const out: Uint32Array[] = [];
  for (let i = 0; i < active.length; i += per) out.push(active.slice(i, i + per));
  return out;
}

/** Run every share on the jobs (each takes the next free share); results in share order. */
export async function runShares(
  jobs: PitchJob[],
  audio16: Float32Array,
  parts: Uint32Array[],
  onProgress: (fraction: number) => void,
): Promise<Float32Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const results: Float32Array[] = new Array(parts.length);
  let next = 0;
  let doneFrames = 0;
  let failed: Error | null = null;
  const worker = async (job: PitchJob) => {
    while (!failed && next < parts.length) {
      const i = next++;
      try {
        results[i] = await job.run(audio16, parts[i]);
      } catch (e) {
        failed ??= new Error(`Analysis failed: ${(e as Error).message}`);
        return;
      }
      doneFrames += parts[i].length;
      onProgress(doneFrames / total);
    }
  };
  await Promise.all(jobs.map(worker));
  if (failed) throw failed;
  if (!parts.length) onProgress(1);
  const out = new Float32Array(total * 2);
  let at = 0;
  for (const r of results) {
    out.set(r, at);
    at += r.length;
  }
  return out;
}

/** How many shares to cut for `workers` workers. */
export const shareCount = (workers: number) => workers * SHARES_PER_WORKER;

/** One pitch worker per core, 2 to 8. */
export const workerCount = (cores: number | undefined) => Math.min(8, Math.max(2, cores ?? 2));
