import "./styles.css";
import * as api from "./api";
import { drawRoll } from "./roll";
import { xToTime, type View } from "./coords";
import type { LoadResp, RNote, TakeInfo } from "./types";
import { DEFAULT_SETTINGS } from "./types";

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

export async function opened(r: LoadResp) {
  app.takeId = r.take_id;
  app.info = r.info;
  say(r.info.warning ?? `${r.info.name}: ${r.info.duration_s.toFixed(1)} s`);
  await refreshTakes(r.info.name);
  app.notes = (await api.render(app.takeId, DEFAULT_SETTINGS)).notes;
  redraw();
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
