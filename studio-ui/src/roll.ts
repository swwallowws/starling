import { cssColor } from "../vendor/design/tokens.js";
import { isBlackKey, noteStrength, tint } from "./colors";
import { fitView, pitchToY, timeToX, type View } from "./coords";
import type { RNote, TakeInfo } from "./types";

export const LOUDNESS_LANE = 48;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function drawRoll(canvas: HTMLCanvasElement, info: TakeInfo, notes: RNote[], playhead: number | null): View {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Resolve tokens on every draw so theme and scheme changes apply on redraw.
  const c = {
    ground: cssColor("--ground"),
    band: cssColor("--band"),
    ink: cssColor("--ink"),
    mut: cssColor("--ink-mut"),
    acc: cssColor("--acc"),
  };
  const font = getComputedStyle(document.body).fontFamily;

  g.fillStyle = c.ground;
  g.fillRect(0, 0, w, h);
  const v = fitView(info, notes, w, h - LOUDNESS_LANE);
  const row = v.height / (v.pHi - v.pLo);

  // Key bands: black-key rows in --band, no lines. Octave label at each C.
  g.font = `10px ${font}`;
  g.textBaseline = "middle";
  for (let p = Math.floor(v.pLo); p <= Math.ceil(v.pHi); p++) {
    const top = pitchToY(v, p + 0.5);
    if (isBlackKey(p)) {
      g.fillStyle = c.band;
      g.fillRect(0, top, w, row);
    }
    if (p % 12 === 0) {
      g.fillStyle = c.mut;
      g.fillText(`${NAMES[0]}${p / 12 - 1}`, 4, pitchToY(v, p));
    }
  }

  // Raw sung contour: 1px --ink-mut at 50%.
  g.strokeStyle = c.mut;
  g.globalAlpha = 0.5;
  g.lineWidth = 1;
  g.beginPath();
  let pen = false;
  info.contour.forEach((pc, i) => {
    if (pc === null) { pen = false; return; }
    const x = timeToX(v, i * info.hop_s);
    const y = pitchToY(v, pc);
    if (pen) g.lineTo(x, y); else g.moveTo(x, y);
    pen = true;
  });
  g.stroke();
  g.globalAlpha = 1;

  // Notes: tints of the accent; the sounding note is full accent with an ink outline.
  const noteH = Math.max(2, row - 1);
  for (const n of notes) {
    const x0 = timeToX(v, n.start);
    const x1 = timeToX(v, n.end);
    const y = pitchToY(v, n.pitch) - noteH / 2;
    const width = Math.max(1, x1 - x0 - 1);
    const sounding = playhead !== null && playhead >= n.start && playhead < n.end;
    g.fillStyle = sounding ? c.acc : tint(c.acc, c.ground, noteStrength(n.velocity));
    g.fillRect(x0, y, width, noteH);
    if (sounding) {
      g.strokeStyle = c.ink;
      g.strokeRect(x0 + 0.5, y + 0.5, width - 1, noteH - 1);
    }
    // What started the note, drawn just above its start so it never reads as
    // part of the pitch line: a slash for a pitch change, a bar for a re-attack,
    // nothing after a gap.
    g.strokeStyle = c.ink;
    if (n.cause === "pitch") {
      g.beginPath(); g.moveTo(x0 + 0.5, y - 1); g.lineTo(x0 + 4.5, y - 7); g.stroke();
    } else if (n.cause === "reattack") {
      g.fillStyle = c.ink;
      g.fillRect(x0, y - 7, 2, 6);
    }
    // Bend curve: 1px ink through the note.
    if (n.bend.length > 1) {
      g.beginPath();
      n.bend.forEach(([t, st], i) => {
        const bx = timeToX(v, t);
        const by = pitchToY(v, n.pitch + st);
        if (i) g.lineTo(bx, by); else g.moveTo(bx, by);
      });
      g.stroke();
    }
  }

  // Loudness lane: --ink-mut on a --band strip.
  const top = h - LOUDNESS_LANE;
  g.fillStyle = c.band;
  g.fillRect(0, top, w, LOUDNESS_LANE);
  g.fillStyle = c.mut;
  info.loudness.forEach((l, i) => {
    const x = timeToX(v, i * info.hop_s);
    g.fillRect(x, h - l * (LOUDNESS_LANE - 4), Math.max(1, timeToX(v, info.hop_s)), l * (LOUDNESS_LANE - 4));
  });

  if (playhead !== null) {
    g.strokeStyle = c.acc;
    const x = Math.round(timeToX(v, playhead)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  return v;
}
