import "./styles.css";
import * as api from "./api";
import { drawRoll } from "./roll";
import { xToTime, type View } from "./coords";
import type { LoadResp, RNote, TakeInfo } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { buildControls } from "./controls";
import { spaceAction } from "./keys";
import { createSettingsStore } from "./settings-store";
import { createTuning, type TuningView } from "./tuning";
import { startPoint } from "./synth";
import { createRenderer } from "./renderer";
import { throttleLatest } from "./throttle";
import { Player } from "./player";
import { AUDIO_URL, currentTake } from "./api";
import { Recorder, defaultTakeName, micError, takeNameFromFile } from "./recorder";
import { downloadUrlData, settingsKey } from "./export";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function say(text: string) {
  $("message").textContent = text;
}

/** Take-picker value that opens a WAV from anywhere on disk. */
const OPEN_FILE = "__open_file__";

async function refreshTakes(select?: string) {
  const takes = await api.listTakes();
  const sel = $<HTMLSelectElement>("takes");
  sel.textContent = "";
  sel.add(new Option("Open a take...", ""));
  for (const t of takes) sel.add(new Option(t, t));
  sel.add(new Option("Open WAV...", OPEN_FILE));
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

/** The single owner of the settings; controls and the tuning picker send patches. */
const store = createSettingsStore(DEFAULT_SETTINGS);

const renderer = createRenderer(
  api.render,
  (r, s) => {
    app.notes = r.notes;
    controls.setFlags(r.flags);
    tuning.renderOk(s);
    redraw();
    onNotesChanged();
    updateDrag();
  },
  (msg) => tuning.renderError(msg),
);
const rerender = throttleLatest(() => app.takeId && renderer.request(app.takeId, store.get()), 33);
const controls = buildControls($("controls"), store);
store.subscribe(() => {
  rerender();
  updateDrag();
});

/** Hook for playback (Task 11) to reschedule when notes change. */
export let onNotesChanged: () => void = () => {};
export function setOnNotesChanged(f: () => void) { onNotesChanged = f; }

const player = new Player();
setOnNotesChanged(() => player.setNotes(app.notes));

async function togglePlay() {
  if (player.playing) player.stop();
  else player.play(startPoint(app.playhead ?? 0, app.info?.duration_s ?? 0));
  $("play").textContent = player.playing ? "Stop (Space)" : "Play (Space)";
  tickPlayhead();
}

function tickPlayhead() {
  app.playhead = player.position();
  redraw();
  if (player.playing) requestAnimationFrame(tickPlayhead);
  else $("play").textContent = "Play (Space)";
}

$("play").addEventListener("click", togglePlay);
document.querySelectorAll<HTMLInputElement>('input[name="listen"]').forEach((r) =>
  r.addEventListener("change", () => player.setMode(r.value as "voice" | "midi" | "both")),
);
$<HTMLCanvasElement>("roll").addEventListener("click", (e) => {
  if (!app.view) return;
  const t = xToTime(app.view, e.offsetX);
  app.playhead = t;
  if (player.playing) player.play(t);
  redraw();
});
const recorder = new Recorder();
const takeName = $<HTMLInputElement>("take-name");
takeName.value = defaultTakeName(new Date());

async function toggleRecord() {
  const btn = $<HTMLButtonElement>("record");
  if (!recorder.active) {
    player.stop();
    try {
      const t0 = performance.now();
      await recorder.start((peak) => {
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        $("rec-status").textContent = `${secs} s  ${"|".repeat(Math.round(peak * 20))}`;
      });
      btn.textContent = "Stop recording (Space)";
    } catch (e) {
      say(micError(e));
    }
    return;
  }
  btn.disabled = true;
  const { wav, seconds } = await recorder.stop();
  btn.textContent = "Record";
  $("rec-status").textContent = "";
  say(`Saving and analyzing ${seconds.toFixed(1)} s...`);
  try {
    await opened(await api.uploadTake(takeName.value, wav));
    takeName.value = defaultTakeName(new Date());
  } catch (e) {
    say((e as Error).message);
  } finally {
    btn.disabled = false;
  }
}

$("record").addEventListener("click", toggleRecord);

let saved: { key: string; fileName: string; takeId: number } | null = null;
const drag = $("drag");

function updateDrag() {
  const fresh = saved && saved.takeId === app.takeId && saved.key === settingsKey(store.get());
  drag.setAttribute("draggable", fresh ? "true" : "false");
  drag.textContent = fresh ? `Drag ${saved!.fileName} into Live` : saved ? "Save again to drag the latest" : "Save first to drag";
}

$("save").addEventListener("click", async () => {
  if (!app.takeId) return;
  try {
    const settings = store.get();
    const r = await api.exportMid(app.takeId, settings);
    saved = { key: settingsKey(settings), fileName: r.file_name, takeId: app.takeId };
    $("saved-path").textContent = r.path;
    $("reveal").hidden = false;
  } catch (e) {
    say((e as Error).message);
  }
  updateDrag();
});

drag.addEventListener("dragstart", (e) => {
  if (!saved) return;
  e.dataTransfer?.setData("DownloadURL", downloadUrlData(saved.fileName, location.origin));
});

$("reveal").addEventListener("click", () => void api.reveal());

document.addEventListener("keydown", (e) => {
  const action = spaceAction(e, recorder.active);
  if (action === "none" || action === "native") return;
  e.preventDefault();
  if (action === "play") void togglePlay();
  if (action === "record") void toggleRecord();
});
// A mouse click must not leave focus on a button, or Space would press it again.
document.addEventListener("mousedown", (e) => {
  if ((e.target as Element).closest("button")) e.preventDefault();
});

// Tuning picker and anchor.
const tuningSel = $<HTMLSelectElement>("tuning");
const sclFile = $<HTMLInputElement>("scl-file");
const anchor = $<HTMLInputElement>("anchor");
anchor.value = String(store.get().anchor_hz);

let tuningView: TuningView = { choice: "12tet", loaded: null, error: null };
function showTuning(v: TuningView) {
  tuningView = v;
  let opt = tuningSel.querySelector<HTMLOptionElement>('option[value="loaded"]');
  if (v.loaded) {
    if (!opt) {
      opt = Object.assign(document.createElement("option"), { value: "loaded" });
      tuningSel.insertBefore(opt, tuningSel.lastElementChild);
    }
    opt.textContent = v.loaded.name;
  }
  tuningSel.value = v.choice === "loaded" ? "loaded" : "";
  $("tuning-error").textContent = v.error ? `${v.error} (kept the previous tuning)` : "";
}
const tuning = createTuning(store, showTuning);

tuningSel.addEventListener("change", () => {
  if (tuningSel.value === "load") {
    showTuning(tuningView); // keep showing the active tuning until a file renders
    sclFile.click();
  } else if (tuningSel.value === "loaded") tuning.chooseLoaded();
  else tuning.choose12();
});
sclFile.addEventListener("change", async () => {
  const f = sclFile.files?.[0];
  sclFile.value = "";
  if (f) tuning.loadFile({ name: f.name, scl: await f.text() });
});
anchor.addEventListener("change", () => {
  const hz = Number(anchor.value);
  if (hz > 0) store.patch({ anchor_hz: hz });
});

export async function opened(r: LoadResp) {
  app.takeId = r.take_id;
  app.info = r.info;
  say(r.info.warning ?? `${r.info.name}: ${r.info.duration_s.toFixed(1)} s`);
  await refreshTakes(r.info.name);
  player.stop();
  app.playhead = 0;
  await player.load(AUDIO_URL);
  // A new take: the previous export no longer applies.
  $("saved-path").textContent = "";
  $("reveal").hidden = true;
  updateDrag();
  renderer.request(app.takeId, store.get());
}

const wavFile = $<HTMLInputElement>("wav-file");
wavFile.addEventListener("change", async () => {
  const f = wavFile.files?.[0];
  wavFile.value = "";
  if (!f) return;
  say(`Analyzing ${f.name}...`);
  try {
    await opened(await api.uploadTake(takeNameFromFile(f.name), await f.arrayBuffer()));
  } catch (err) {
    say((err as Error).message);
  }
});

$<HTMLSelectElement>("takes").addEventListener("change", async (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (name === OPEN_FILE) {
    (e.target as HTMLSelectElement).value = app.info?.name ?? "";
    wavFile.click();
    return;
  }
  if (!name) return;
  say(`Analyzing ${name}...`);
  try {
    await opened(await api.openTake(name));
  } catch (err) {
    say((err as Error).message);
  }
});

// Show a take the studio was started with (`voxmpe studio take.wav`), else just list takes.
currentTake()
  .then((r) => (r ? opened(r) : refreshTakes()))
  .catch((e) => say(e.message));
