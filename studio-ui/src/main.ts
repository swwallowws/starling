import "./styles.css";
import { backend as api } from "./backend-impl";
import { drawRoll } from "./roll";
import { attachRollInput } from "./roll-input";
import type { View } from "./coords";
import type { LoadResp, Preset, RNote, TakeInfo } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { buildControls } from "./controls";
import { spaceAction, zoomKey } from "./keys";
import { createSettingsStore, loadSettings, saveSettings } from "./settings-store";
import { missingFeatures } from "./web/support";
import { createTuning, type TuningView } from "./tuning";
import { anchorNotes, formatHz, matchAnchor } from "./anchor";
import { startPoint } from "./synth";
import { createRenderer } from "./renderer";
import { throttleLatest } from "./throttle";
import { Player } from "./player";
import { Recorder, defaultTakeName, micError, takeNameFromFile } from "./recorder";
import { downloadUrlData, loadFormats, nextFormats, saveFormats, settingsKey, type Format } from "./export";
import type { SavedFile } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function say(text: string) {
  $("message").textContent = text;
}

/** The browser build can't run here (missing SIMD, workers or IndexedDB). */
const unsupported = api.kind === "web" && missingFeatures().length > 0;
if (api.kind === "web") {
  $("privacy").hidden = false;
  if (unsupported) {
    say(`This browser is missing ${missingFeatures().join(", ")}. Try a current Chrome, Edge, Firefox or Safari.`);
    for (const id of ["record", "takes"]) $<HTMLButtonElement>(id).disabled = true;
  }
}

/** Progress for an analysis, shown in the message line. */
const analyzing = (name: string) => (f: number) => say(`Analyzing ${name}... ${Math.round(f * 100)}%`);

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
  fit: null as View | null,
};

export function redraw() {
  if (!app.info) return;
  const { view, fit } = drawRoll($<HTMLCanvasElement>("roll"), app.info, app.notes, app.playhead, rollInput.zoom());
  app.view = view;
  app.fit = fit;
  $("fit").hidden = !rollInput.zoomed();
  $("note-count").textContent = `${app.notes.length} notes`;
}

const rollInput = attachRollInput($<HTMLCanvasElement>("roll"), {
  views: () => (app.view && app.fit ? { view: app.view, fit: app.fit } : null),
  seek(t) {
    app.playhead = t;
    if (player.playing) player.play(t);
    redraw();
  },
  redraw,
});
$("fit").addEventListener("click", () => rollInput.reset());

window.addEventListener("resize", redraw);
// Canvas colours are resolved per draw; redraw when the system scheme flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);

/** The single owner of the settings; controls and the tuning picker send patches. */
const store = createSettingsStore(loadSettings(localStorageOrNull(), DEFAULT_SETTINGS));
store.subscribe((s) => saveSettings(localStorageOrNull(), s));

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
  rollInput.follow(app.playhead);
  redraw();
  if (player.playing) requestAnimationFrame(tickPlayhead);
  else $("play").textContent = "Play (Space)";
}

$("play").addEventListener("click", togglePlay);
document.querySelectorAll<HTMLInputElement>('input[name="listen"]').forEach((r) =>
  r.addEventListener("change", () => player.setMode(r.value as "voice" | "midi" | "both")),
);
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
    await opened(await api.uploadTake(takeName.value, wav, analyzing(takeName.value)));
    takeName.value = defaultTakeName(new Date());
  } catch (e) {
    say((e as Error).message);
  } finally {
    btn.disabled = false;
  }
}

$("record").addEventListener("click", toggleRecord);

let saved: { key: string; files: SavedFile[]; takeId: number } | null = null;
const drags = $("drags");

// Which files Save writes: remembered in this browser, .mid alone by default.
let formats: Format[] = loadFormats(localStorageOrNull());
const formatBoxes = [...document.querySelectorAll<HTMLInputElement>('input[name="format"]')];
function syncFormats() {
  for (const box of formatBoxes) box.checked = formats.includes(box.value as Format);
}
for (const box of formatBoxes) {
  box.addEventListener("change", () => {
    formats = nextFormats(formats, box.value as Format, box.checked);
    saveFormats(localStorageOrNull(), formats);
    syncFormats();
  });
}
syncFormats();

function localStorageOrNull(): Storage {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} } as unknown as Storage;
  }
}

/** One drag handle per saved file, live only while it matches the current take and settings. */
function updateDrag() {
  if (!api.canDragOut) {
    drags.replaceChildren();
    return;
  }
  const fresh = !!saved && saved.takeId === app.takeId && saved.key === settingsKey(store.get());
  drags.replaceChildren();
  if (!saved) {
    drags.append(handle("Save first to drag", false));
    return;
  }
  if (!fresh) {
    drags.append(handle("Save again to drag the latest", false));
    return;
  }
  for (const f of saved.files) {
    const h = handle(`Drag ${f.file_name}`, true);
    h.title = f.format === "als" ? "Drop into Live: the clip keeps each note's pitch curve" : "Drop into any DAW";
    h.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("DownloadURL", downloadUrlData(f.format, f.file_name, f.url));
    });
    drags.append(h);
  }
}

function handle(text: string, live: boolean) {
  const h = Object.assign(document.createElement("span"), { className: "drag", textContent: text });
  h.setAttribute("draggable", live ? "true" : "false");
  return h;
}

$("save").addEventListener("click", async () => {
  if (!app.takeId) return;
  try {
    const settings = store.get();
    const r = await api.exportFiles(app.takeId, settings, formats);
    saved = { key: settingsKey(settings), files: r.files, takeId: app.takeId };
    $("saved-path").textContent = r.files.map((f) => f.path ?? f.file_name).join("  ");
    $("reveal").hidden = !api.canReveal;
  } catch (e) {
    say((e as Error).message);
  }
  updateDrag();
});

$("reveal").addEventListener("click", () => void api.reveal());

document.addEventListener("keydown", (e) => {
  const zk = zoomKey(e);
  if (zk !== "none" && app.info) {
    e.preventDefault();
    rollInput.key(zk);
    return;
  }
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

// Tuning picker: 12-TET, the built-in tunings, the last loaded file, Load .scl...
const tuningSel = $<HTMLSelectElement>("tuning");
const sclFile = $<HTMLInputElement>("scl-file");
let presets: Preset[] = [];
let tuningView: TuningView = { active: null, custom: null, error: null };

function showTuning(v: TuningView) {
  tuningView = v;
  tuningSel.textContent = "";
  tuningSel.add(new Option("12-TET", ""));
  for (const p of presets) tuningSel.add(new Option(p.name, `preset:${p.id}`));
  // A remembered built-in tuning starts as `custom` too; list it only once.
  if (v.custom && !presets.some((p) => p.scl === v.custom!.scl)) tuningSel.add(new Option(v.custom.name, "custom"));
  tuningSel.add(new Option("Load .scl...", "load"));
  const a = v.active;
  const isPreset = a && presets.some((p) => p.id === a.name && p.scl === a.scl);
  tuningSel.value = !a ? "" : isPreset ? `preset:${a.name}` : "custom";
  $("tuning-error").textContent = v.error ? `${v.error} (kept the previous tuning)` : "";
}
const tuning = createTuning(store, showTuning);
showTuning(tuning.view());
api
  .listTunings()
  .then((list) => {
    presets = list;
    showTuning(tuningView);
  })
  .catch((e) => say(e.message));

tuningSel.addEventListener("change", () => {
  const v = tuningSel.value;
  if (v === "load") {
    showTuning(tuningView); // keep showing the active tuning until a file renders
    sclFile.click();
  } else if (v === "custom") tuning.chooseCustom();
  else if (v.startsWith("preset:")) {
    const p = presets.find((x) => `preset:${x.id}` === v);
    if (p) tuning.choose({ name: p.id, scl: p.scl });
  } else tuning.choose(null);
});
sclFile.addEventListener("change", async () => {
  const f = sclFile.files?.[0];
  sclFile.value = "";
  if (f) tuning.loadFile({ name: f.name, scl: await f.text() });
});

// Anchor: the scale's first note, as a note name with its frequency, or a custom Hz.
const anchorSel = $<HTMLSelectElement>("anchor");
const anchorCustom = $<HTMLInputElement>("anchor-custom");
for (const n of anchorNotes()) anchorSel.add(new Option(n.label, String(n.hz)));
anchorSel.add(new Option("Custom...", "custom"));
function showAnchor(hz: number) {
  const m = matchAnchor(hz);
  anchorSel.value = m ? String(m.hz) : "custom";
  anchorCustom.hidden = m !== null;
  anchorCustom.value = formatHz(hz);
}
showAnchor(store.get().anchor_hz);
anchorSel.addEventListener("change", () => {
  if (anchorSel.value === "custom") {
    anchorCustom.hidden = false;
    anchorCustom.focus();
  } else store.patch({ anchor_hz: Number(anchorSel.value) });
});
anchorCustom.addEventListener("change", () => {
  const hz = Math.round(Number(anchorCustom.value) * 10) / 10;
  if (hz > 0) {
    store.patch({ anchor_hz: hz });
    showAnchor(hz);
  }
});

export async function opened(r: LoadResp) {
  app.takeId = r.take_id;
  app.info = r.info;
  say(r.info.warning ?? `${r.info.name}: ${r.info.duration_s.toFixed(1)} s`);
  document.body.dataset.analysis = r.cached ? "cached" : "fresh";
  $("empty").hidden = true;
  $("delete-take").hidden = !api.canDelete;
  await refreshTakes(r.info.name);
  player.stop();
  rollInput.clear();
  app.playhead = 0;
  await player.load(api.audioUrl());
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
    await opened(await api.uploadTake(takeNameFromFile(f.name), await f.arrayBuffer(), analyzing(f.name)));
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
    await opened(await api.openTake(name, analyzing(name)));
  } catch (err) {
    say((err as Error).message);
  }
});

$("delete-take").addEventListener("click", async () => {
  const name = app.info?.name;
  if (!name || !confirm(`Delete ${name} from this browser?`)) return;
  try {
    await api.deleteTake(name);
  } catch (e) {
    say((e as Error).message);
    return;
  }
  player.stop();
  app.info = null;
  app.takeId = 0;
  app.notes = [];
  saved = null;
  const roll = $<HTMLCanvasElement>("roll");
  roll.getContext("2d")?.clearRect(0, 0, roll.width, roll.height);
  $("delete-take").hidden = true;
  $("empty").hidden = false;
  $("note-count").textContent = "";
  updateDrag();
  say(`Deleted ${name}.`);
  await refreshTakes();
});

// Show a take the studio was started with (`voxmpe studio take.wav`), else just list takes.
// An unsupported browser keeps its message instead.
if (!unsupported) api
  .currentTake()
  .then((r) => (r ? opened(r) : refreshTakes()))
  .catch((e) => {
    say(`${e.message}. `);
    const retry = Object.assign(document.createElement("button"), { textContent: "Retry" });
    retry.onclick = () => location.reload();
    $("message").append(retry);
  });
