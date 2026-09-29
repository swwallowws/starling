// The sounds MIDI playback uses: the shared General MIDI bank (vendor/design/sound/gm.sf3,
// GeneralUser GS; credit in vendor/design/sound/NOTICE), and the instrument a sung line plays with.

/** Fetched once and kept in the Cache API. The build names the file by its content hash, so a
 * new bank is a new URL and replaces the old entry. */
const SOUNDFONT = new URL("../vendor/design/sound/gm.sf3", import.meta.url).href;
const CACHE = "starling-soundfont";
let bank: Promise<ArrayBuffer> | null = null;

export function soundfontBytes(): Promise<ArrayBuffer> {
  bank ??= (async () => {
    let cache: Cache | null = null;
    try { cache = await caches.open(CACHE); } catch { /* no Cache API here: fetch every time */ }
    let res = cache && (await cache.match(SOUNDFONT));
    if (!res) {
      res = await fetch(SOUNDFONT);
      if (!res.ok) throw new Error(`the instrument sounds did not load (${res.status})`);
      if (cache) {
        for (const old of await cache.keys()) if (old.url !== SOUNDFONT) await cache.delete(old);
        await cache.put(SOUNDFONT, res.clone()).catch(() => {});
      }
    }
    return res.arrayBuffer();
  })();
  bank.catch(() => { bank = null; }); // a failed load can be tried again
  return bank;
}

/** Start fetching the bank now, so it is there by the first Play. */
export function prefetchSoundfont() {
  soundfontBytes().catch(() => {});
}

/** The one General MIDI program (0-based) the notes play with: Electric Piano. */
export const PROGRAM = 4;
