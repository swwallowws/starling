// The empty roll's sentence sits inside the roll box's DEMO mark. Rather than
// letting a word of the mark run through the sentence, the tiles whose word
// would come near it are left out, so the mark stays a grid of whole words
// with a clear hole where the sentence is.

export type Box = { left: number; top: number; right: number; bottom: number };

/** True when a and b overlap once b is grown by pad on every side. */
export function near(a: Box, b: Box, pad: number): boolean {
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
}

/** For each word, whether it comes within pad of any of the text's line boxes. */
export function wordsNearText(words: Box[], lines: Box[], pad: number): boolean[] {
  return words.map((w) => lines.some((l) => near(w, l, pad)));
}

/** Clearance between a word of the mark and the sentence, in px. */
export const CLEAR_PAD = 8;

/**
 * Hides the tiles of the mark inside box that would touch text, or shows
 * them all again when text is null or hidden. Call it whenever either moves.
 */
export function clearMarkBehind(box: HTMLElement, text: HTMLElement | null): void {
  const mark = box.querySelector<HTMLElement>(":scope > .demoshell-mark");
  if (!mark) return;
  const tiles = [...mark.children] as HTMLElement[];
  for (const t of tiles) t.style.visibility = "";
  if (!text || text.closest("[hidden]")) return;
  const lines = [...text.getClientRects()];
  if (!lines.length) return;
  // Only the tiles in rows that show; the rest sit in zero-height rows.
  const shown = tiles.filter((t) => t.getBoundingClientRect().height > 0);
  const words = shown.map((t) => {
    const r = document.createRange();
    r.selectNodeContents(t);
    return r.getBoundingClientRect();
  });
  wordsNearText(words, lines, CLEAR_PAD).forEach((hit, i) => {
    if (hit) shown[i].style.visibility = "hidden";
  });
}
