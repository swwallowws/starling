// The sounds MIDI playback uses: the shared General MIDI bank (vendor/design/sound/gm.sf3,
// GeneralUser GS; credit in vendor/design/sound/NOTICE), and the instrument a sung line plays with.

import { fetchSoundfont } from "../vendor/design/sound/soundfont.js";

/** From the design's fetchSoundfont: the one copy every studio on the site shares, fetched once
 * and kept in the Cache API, else this build's own (named by its content hash). */
const SOUNDFONT = new URL("../vendor/design/sound/gm.sf3", import.meta.url).href;
const OLD_CACHE = "starling-soundfont"; // where this site kept its own copy before
let bank: Promise<ArrayBuffer> | null = null;

export function soundfontBytes(): Promise<ArrayBuffer> {
  bank ??= fetchSoundfont(SOUNDFONT, { retire: [OLD_CACHE] });
  bank.catch(() => { bank = null; }); // a failed load can be tried again
  return bank;
}

/** Start fetching the bank now, so it is there by the first Play. */
export function prefetchSoundfont() {
  soundfontBytes().catch(() => {});
}

/** The one General MIDI program (0-based) every take's notes play with: Vibraphone, picked
 *  by ear (its clear attack makes each note start easy to hear). */
export const PROGRAM = 11;
