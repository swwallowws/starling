import "./styles.css";
import * as api from "./api";
import { drawRoll } from "./roll";
import { xToTime, type View } from "./coords";
import type { LoadResp, RNote, Settings, TakeInfo } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { buildControls } from "./controls";
import { createRenderer } from "./renderer";
import { throttleLatest } from "./throttle";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function say(text: string) {
  $("message").textContent = text;
}

async function refreshTakes(select?: string) {
  const takes = await api.listTakes();
  const sel = $<HTMLSelectElement>("takes");
  sel.textContent = "";
  sel.add(new Option("Open a take...", ""));
  for (const t of takes) sel.add(new Option(t, t));
  if (select) sel.value = select;
}

export const app = {
  takeId: 0,
  info: null as TakeInfo | null,
  notes: [] as RNote[],
  playhead: null as number | null,
  view: null as View | null,
};

export function redraw() {
  if (!app.info) return;
  app.view = drawRoll($<HTMLCanvasElement>("roll"), app.info, app.notes, app.playhead);
  $("note-count").textContent = `${app.notes.length} notes`;
}

window.addEventListener("resize", redraw);
// Canvas colours are resolved per draw; redraw when the system scheme flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);

let settings: Settings = { ...DEFAULT_SETTINGS };

const renderer = createRenderer(
  api.render,
  (r, s) => {
    app.notes = r.notes;
    controls.setFlags(r.flags);
    if (s.tuning_scl === settings.tuning_scl) $("tuning-error").textContent = "";
    redraw();
    onNotesChanged();
  },
  (msg) => {
    $("tuning-error").textContent = `${msg} (kept the previous tuning)`;
    settings = { ...settings, tuning_name: renderer.lastGood().tuning_name, tuning_scl: renderer.lastGood().tuning_scl };
    $<HTMLSelectElement>("tuning").value = settings.tuning_name ? "loaded" : "";
  },
);
const rerender = throttleLatest(() => app.takeId && renderer.request(app.takeId, settings), 33);
const controls = buildControls($("controls"), settings, (s) => { settings = s; rerender(); });

/** Hook for playback (Task 11) to reschedule when notes change. */
export let onNotesChanged: () => void = () => {};
export function setOnNotesChanged(f: () => void) { onNotesChanged = f; }

// Tuning picker and anchor.
const tuningSel = $<HTMLSelectElement>("tuning");
const sclFile = $<HTMLInputElement>("scl-file");
const anchor = $<HTMLInputElement>("anchor");
anchor.value = String(settings.anchor_hz);
tuningSel.addEventListener("change", () => {
  if (tuningSel.value === "load") { sclFile.click(); return; }
  if (tuningSel.value === "") { settings = { ...settings, tuning_name: null, tuning_scl: null }; rerender(); }
});
sclFile.addEventListener("change", async () => {
  const f = sclFile.files?.[0];
  if (!f) return;
  settings = { ...settings, tuning_name: f.name, tuning_scl: await f.text() };
  let opt = tuningSel.querySelector<HTMLOptionElement>('option[value="loaded"]');
  if (!opt) { opt = Object.assign(document.createElement("option"), { value: "loaded" }); tuningSel.insertBefore(opt, tuningSel.lastElementChild); }
  opt.textContent = f.name;
  tuningSel.value = "loaded";
  sclFile.value = "";
  rerender();
});
anchor.addEventListener("change", () => {
  const hz = Number(anchor.value);
  if (hz > 0) { settings = { ...settings, anchor_hz: hz }; rerender(); }
});

export async function opened(r: LoadResp) {
  app.takeId = r.take_id;
  app.info = r.info;
  say(r.info.warning ?? `${r.info.name}: ${r.info.duration_s.toFixed(1)} s`);
  await refreshTakes(r.info.name);
  renderer.request(app.takeId, settings);
}

$<HTMLSelectElement>("takes").addEventListener("change", async (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (!name) return;
  say(`Analyzing ${name}...`);
  try {
    await opened(await api.openTake(name));
  } catch (err) {
    say((err as Error).message);
  }
});

refreshTakes().catch((e) => say(e.message));
