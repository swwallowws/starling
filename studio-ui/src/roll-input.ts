import { xToTime, type View } from "./coords";
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
  seek(t: number): void;
  redraw(): void;
}

/** Zoom and pan for the roll: pinch or Cmd/Ctrl+wheel zooms around the cursor,
 *  two-finger scroll or drag pans, a click seeks, double-click fits. Gestures
 *  set a target window and the view glides to it (or jumps, with reduced motion). */
export function attachRollInput(canvas: HTMLCanvasElement, deps: RollInputDeps) {
  let cur: Win | null = null;
  let target: Win | null = null;
  let raf = 0;
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

  canvas.addEventListener("pointerdown", (e) => {
    const b = base();
    if (e.button !== 0 || !b) return;
    press = { x: e.offsetX, y: e.offsetY, win: b, dragged: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    const v = deps.views();
    if (!press || !v) return;
    const dx = e.offsetX - press.x;
    const dy = e.offsetY - press.y;
    if (!press.dragged && Math.hypot(dx, dy) < DRAG_PX) return;
    press.dragged = true;
    if (!target) return; // nothing to pan at the fitted view
    canvas.style.cursor = "grabbing";
    setTarget(panBy(press.win, v.fit, -dx / v.view.width, dy / v.view.height), false);
  });
  canvas.addEventListener("pointerup", (e) => {
    const v = deps.views();
    if (press && !press.dragged && v) deps.seek(xToTime(v.view, e.offsetX));
    press = null;
    canvas.style.cursor = target ? "grab" : "";
  });
  canvas.addEventListener("pointercancel", () => { press = null; });
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
      if (!target || !f || press?.dragged) return;
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
