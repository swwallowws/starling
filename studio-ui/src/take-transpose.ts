// Each take keeps its own Transpose: whatever it was last set to comes back when the take is
// opened again. A take never set starts at 0, the starling's song at its own value. Kept in
// this browser, by take name.
import { SAMPLE_TRANSPOSE, isSampleTake } from "./try/sample";

const KEY = "voxmpe:take-transpose";

type Store = Pick<Storage, "getItem" | "setItem">;

function read(storage: Store): Record<string, number> {
  try {
    const m = JSON.parse(storage.getItem(KEY) ?? "{}");
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

/** The Transpose a take opens with. */
export function transposeFor(storage: Store, take: string): number {
  const saved = read(storage)[take];
  if (typeof saved === "number" && Number.isFinite(saved)) return saved;
  return isSampleTake(take) ? SAMPLE_TRANSPOSE : 0;
}

/** Remember a take's Transpose. */
export function rememberTranspose(storage: Store, take: string, semitones: number) {
  const m = read(storage);
  m[take] = semitones;
  try { storage.setItem(KEY, JSON.stringify(m)); } catch { /* storage full or off: it starts fresh next time */ }
}

/** A deleted take's Transpose goes with it. */
export function forgetTranspose(storage: Store, take: string) {
  const m = read(storage);
  if (!(take in m)) return;
  delete m[take];
  try { storage.setItem(KEY, JSON.stringify(m)); } catch { /* nothing to undo */ }
}
