// Takes and their analysis, kept in this browser (IndexedDB). Nothing is uploaded.

/** The model the cached analysis came from; a different model means re-analyze. */
export const MODEL_ID = "crepe-tiny";

const DB = "voxmpe";
const STORE = "takes";

interface Row {
  name: string;
  wav: ArrayBuffer;
  frames: Float32Array | null;
  model: string | null;
  created: number;
}

/** A take name safe to store and show: the server's rules (see server.rs `sanitize_stem`). */
export function sanitizeStem(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/\.wav$/, "");
  const s = [...base]
    .map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "-"))
    .join("")
    .split("-")
    .filter(Boolean)
    .join("-");
  return s ? [...s].slice(0, 60).join("") : "take";
}

export interface TakeStore {
  list(): Promise<string[]>;
  get(name: string): Promise<{ wav: ArrayBuffer; frames: Float32Array | null } | null>;
  add(requested: string, wav: ArrayBuffer): Promise<string>;
  setFrames(name: string, frames: Float32Array): Promise<void>;
  remove(name: string): Promise<void>;
}

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((ok, fail) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });

export async function openTakeStore(factory: IDBFactory = indexedDB): Promise<TakeStore> {
  const open = factory.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "name" });
  const db = await done(open);
  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);

  return {
    async list() {
      const keys = await done(store("readonly").getAllKeys());
      return (keys as string[]).sort();
    },
    async get(name) {
      const row = (await done(store("readonly").get(name))) as Row | undefined;
      if (!row) return null;
      return { wav: row.wav, frames: row.model === MODEL_ID ? row.frames : null };
    },
    async add(requested, wav) {
      const stem = sanitizeStem(requested);
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const taken = new Set((await done(s.getAllKeys())) as string[]);
      let name = `${stem}.wav`;
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.wav`;
      const row: Row = { name, wav, frames: null, model: null, created: Date.now() };
      s.add(row);
      await finished(tx);
      return name;
    },
    async setFrames(name, frames) {
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const row = (await done(s.get(name))) as Row | undefined;
      if (row) s.put({ ...row, frames, model: MODEL_ID });
      await finished(tx);
    },
    async remove(name) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(name);
      await finished(tx);
    },
  };
}
