import { seekable } from "../vendor/design/playhead.js";
import { onHead, pointerTime, type View } from "./coords";
import type { ZoomKey } from "./keys";
import { clampWin, follow, isFit, panBy, step, zoomAt, type Win } from "./zoom";

/** Share of the remaining distance a glide covers per frame. */
const GLIDE = 0.3;
/** Wheel/pinch delta to zoom factor: exp(delta * this). */
const WHEEL_ZOOM = 0.01;
/** Largest delta one wheel event counts for, so a mouse notch (~100) zooms
 *  about 1.5x instead of jumping. Trackpad pinch deltas are far smaller. */
const WHEEL_MAX = 40;
/** Keyboard zoom step. */
const KEY_ZOOM = 0.7;
/** Pointer travel (px) that turns a click into a drag. */
const DRAG_PX = 3;

export interface RollInputDeps {
  /** What is on screen now and the whole fitted view, from the last draw. */
  views(): { view: View; fit: View } | null;
  /** Where the playhead is drawn now, to tell a press on its line. */
  playhead(): number | null;
  /** The head is held at `t` by a press or drag (design playhead.js onScrub). */
  scrub(t: number): void;
  /** The press was let go at `t`: move the playback there. */
  seek(t: number): void;
  /** The scrub was taken over or cancelled: show the real position again. */
  cancelScrub(): void;
  redraw(): void;
}

/** Zoom, pan and seeking for the roll: pinch or Cmd/Ctrl+wheel zooms around the
 *  cursor, two-finger scroll pans, double-click fits. A click or drag moves the
 *  playhead (the design system's seekable()); when zoomed in, a drag pans instead
 *  unless it starts on the playhead line. Zoom gestures set a target window and
 *  the view glides to it (or jumps, with reduced motion). */
export function attachRollInput(canvas: HTMLCanvasElement, deps: RollInputDeps) {
  let cur: Win | null = null;
  let target: Win | null = null;
  let raf = 0;
  let mode: "scrub" | "pan" | null = null;
  let press: { x: number; y: number; win: Win; dragged: boolean } | null = null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  const fit = () => deps.views()?.fit ?? null;
  const base = () => target ?? fit();

  function frame() {
    const f = fit();
    raf = 0;
    if (!f) return;
    const [next, done] = step(cur ?? f, target ?? f, GLIDE);
    cur = done ? target : next;
    deps.redraw();
    if (!done) raf = requestAnimationFrame(frame);
  }

  function setTarget(w: Win, glide: boolean) {
    const f = fit();
    if (!f) return;
    const clamped = clampWin(w, f);
    target = isFit(clamped, f) ? null : clamped;
    canvas.style.cursor = target ? "grab" : "";
    if (!glide || reduced.matches) {
      cancelAnimationFrame(raf);
      raf = 0;
      cur = target;
      deps.redraw();
    } else if (!raf) {
      raf = requestAnimationFrame(frame);
    }
  }

  canvas.addEventListener(
    "wheel",
    (e) => {
      const v = deps.views();
      const b = base();
      if (!v || !b) return;
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch arrives as a wheel event with ctrlKey set.
        e.preventDefault();
        const fx = e.offsetX / v.view.width;
        const fy = Math.min(1, Math.max(0, e.offsetY / v.view.height));
        setTarget(zoomAt(b, v.fit, fx, fy, Math.exp(Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, e.deltaY * unit)) * WHEEL_ZOOM)), true);
      } else if (target) {
        e.preventDefault();
        setTarget(panBy(b, v.fit, (e.deltaX * unit) / v.view.width, (-e.deltaY * unit) / v.view.height), false);
      }
    },
    { passive: false },
  );

  // Each press is either a scrub (the fitted view, or the playhead line when zoomed)
  // or a pan (zoomed, anywhere else; a pan that never moved is a click and seeks).
  // Registered before seekable() below, so the mode is set before it asks enabled().
  canvas.addEventListener("pointerdown", (e) => {
    const v = deps.views();
    const b = base();
    mode = null;
    press = null;
    if (e.button > 0 || !v || !b) return;
    if (!target || onHead(v.view, deps.playhead(), e.offsetX)) mode = "scrub";
    else {
      mode = "pan";
      press = { x: e.offsetX, y: e.offsetY, win: b, dragged: false };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const v = deps.views();
    if (!press || !v) return;
    const dx = e.offsetX - press.x;
    const dy = e.offsetY - press.y;
    if (!press.dragged && Math.hypot(dx, dy) < DRAG_PX) return;
    press.dragged = true;
    canvas.style.cursor = "grabbing";
    setTarget(panBy(press.win, v.fit, -dx / v.view.width, dy / v.view.height), false);
  });
  const endPress = () => {
    mode = null;
    press = null;
    canvas.style.cursor = target ? "grab" : "";
  };
  seekable(canvas, {
    toTime(clientX, rect) {
      const v = deps.views();
      return v ? pointerTime(v.view, clientX, rect.left, rect.width, v.fit.t1) : 0;
    },
    enabled: () => mode !== null,
    onScrub(t) {
      if (mode === "scrub") deps.scrub(t);
    },
    onSeek(t) {
      if (mode === "scrub" || (mode === "pan" && !press?.dragged)) deps.seek(t);
      endPress();
    },
    onCancel() {
      if (mode === "scrub") deps.cancelScrub();
      endPress();
    },
  });
  canvas.addEventListener("dblclick", () => reset());

  function reset() {
    const f = fit();
    if (f) setTarget(f, true);
  }

  return {
    /** The window to draw, or null for the fitted view. */
    zoom: () => cur,
    zoomed: () => target !== null,
    reset,
    /** Forget the zoom at once (a new take). */
    clear() {
      cancelAnimationFrame(raf);
      raf = 0;
      cur = target = null;
      canvas.style.cursor = "";
    },
    /** While playing, page the view along with the playhead. */
    follow(playhead: number) {
      const f = fit();
      if (!target || !f || mode !== null) return; // not while a press holds the view or the head
      const next = follow(target, f, playhead);
      if (next !== target) setTarget(next, true);
    },
    key(k: ZoomKey) {
      const f = fit();
      const b = base();
      if (!f || !b || k === "none") return;
      if (k === "fit") reset();
      else setTarget(zoomAt(b, f, 0.5, 0.5, k === "in" ? KEY_ZOOM : 1 / KEY_ZOOM), true);
    },
  };
}
