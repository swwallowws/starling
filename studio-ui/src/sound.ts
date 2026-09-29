// The sounds MIDI playback uses: the shared General MIDI bank (vendor/design/sound/gm.sf3,
// GeneralUser GS; credit in vendor/design/sound/NOTICE), and the instruments offered for a sung line.

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

/** General MIDI programs (0-based) for a sung line: synths, which read as the melody without
 * sounding like a second voice, then one keyboard. Square Lead is the default: a fast attack and
 * no vibrato of its own (the pitch curve brings the vibrato), and its layers bend at most 35 cents
 * on the attack, where Saw Lead layers a saw that sweeps 4 semitones into every note. In this bank
 * Chiffer Lead plays the Square Lead preset and Warm Pad, Fantasia, Halo and Sweep Pad play
 * Polysynth, so each is listed once. */
export const INSTRUMENTS = [
  { program: 80, name: "Square Lead" },
  { program: 81, name: "Saw Lead" },
  { program: 90, name: "Polysynth" },
  { program: 4, name: "Electric Piano" },
] as const;

/** A remembered program not in the list (an older choice such as Voice Oohs) falls back to this. */
export const DEFAULT_PROGRAM = 80;
const KEY = "starling.instrument";

/** The remembered instrument, or the default. */
export function loadProgram(): number {
  try {
    const saved = localStorage.getItem(KEY);
    const p = Number(saved);
    if (saved !== null && INSTRUMENTS.some((i) => i.program === p)) return p;
  } catch { /* storage blocked */ }
  return DEFAULT_PROGRAM;
}

export function saveProgram(program: number) {
  try { localStorage.setItem(KEY, String(program)); } catch { /* storage blocked */ }
}
