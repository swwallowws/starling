/** Canvas cannot read var() or light-dark(): tokens are resolved to rgb() with
 *  cssColor() from the design system, then mixed here. */
export function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** Mix `acc` over `ground` at strength `p` (0..1), in sRGB. */
export function tint(acc: string, ground: string, p: number): string {
  const a = parseRgb(acc);
  const g = parseRgb(ground);
  const c = a.map((v, i) => Math.round(v * p + g[i] * (1 - p)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** roll.md: tint strength by pitch, 40% at the lowest pitch in view (`lo`) up to
 *  100% at the highest (`hi`), one gradient along the line. */
export function noteStrength(pitch: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 1;
  return 0.4 + 0.6 * Math.min(1, Math.max(0, (pitch - lo) / (hi - lo)));
}

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlackKey = (p: number) => BLACK.has(((Math.round(p) % 12) + 12) % 12);
