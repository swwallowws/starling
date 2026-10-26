import "./styles.css";
import { backend as api } from "./backend-impl";
import { drawRoll, type Listen } from "./roll";
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
import { Recorder, micError, nextTakeName, takeLabel, takeNameFromFile } from "./recorder";
import { downloadUrlData, loadFormats, nextFormats, saveFormats, settingsKey, type Format } from "./export";
import type { SavedFile } from "./types";
import { SAMPLE_NAME, SAMPLE_TRANSPOSE, browserDecode, isSampleTake, sampleWav } from "./try/sample";
import { forgetTranspose, rememberTranspose, transposeFor } from "./take-transpose";
import { settingsOnOpen } from "./take-settings";
import { iconButton } from "../vendor/design/iconbutton.js";
import { themeSwitch } from "../vendor/design/themeswitch.js";
import { valueBox } from "../vendor/design/valuebox.js";
import { contactForm } from "../vendor/design/contact.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Record and Play are the design's icon toggles, as in the demo: record turns to
// stop while recording, play to pause while playing. Their state follows the
// recorder and the player, set below; a click flips it first, then is corrected.
const recordBtn = iconButton($<HTMLButtonElement>("record"));
const playBtn = iconButton($<HTMLButtonElement>("play"));
iconButton($<HTMLButtonElement>("delete-take"));

// "Get in touch" at the footer's right, the form every studio shares.
contactForm($("contact"), { subject: "Starling: new message" });

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
  sel.add(new Option("Open a take…", ""));
  for (const t of takes) sel.add(new Option(takeLabel(t), t));
  sel.add(new Option("Open a WAV file…", OPEN_FILE));
  if (select) sel.value = select;
  // the next recording's name, shown in its field until someone types their own
  $<HTMLInputElement>("take-name").placeholder = nextTakeName(takes.map(takeLabel));
}

export const app = {
  takeId: 0,
  info: null as TakeInfo | null,
  notes: [] as RNote[],
  playhead: null as number | null,
  /** Where a drag holds the head while playing, drawn in place of the playhead. */
  scrub: null as number | null,
  view: null as View | null,
  fit: null as View | null,
  /** The transpose the shown notes were made with, so the sung line moves with them. */
  transpose: 0,
  /** What you hear: it leads the roll. */
  listen: "midi" as Listen,
};

export function redraw() {
  if (!app.info) return;
  const { view, fit } = drawRoll($<HTMLCanvasElement>("roll"), app.info, app.notes, app.scrub ?? app.playhead, rollInput.zoom(), app.transpose, app.listen);
  app.view = view;
  app.fit = fit;
  $("fit").hidden = !rollInput.zoomed();
  $("note-count").textContent = `${app.notes.length} notes`;
}

const rollInput = attachRollInput($<HTMLCanvasElement>("roll"), {
  views: () => (app.view && app.fit ? { view: app.view, fit: app.fit } : null),
  playhead: () => app.scrub ?? app.playhead,
  // Paused, a press or drag moves the place Play starts from. Playing, the head
  // follows the pointer and the sound moves once, on release.
  scrub(t) {
    if (player.playing) app.scrub = t;
    else app.playhead = t;
    redraw();
  },
  seek(t) {
    app.scrub = null;
    app.playhead = t;
    if (player.playing) player.play(t);
    redraw();
  },
  cancelScrub() {
    app.scrub = null;
    redraw();
  },
  redraw,
});
$("fit").addEventListener("click", () => rollInput.reset());

window.addEventListener("resize", redraw);
// System, Paper or Night: the mode every product shares; the roll repaints in it.
themeSwitch($("modes"), { onChange: () => redraw() });
// Canvas colours are resolved per draw; redraw when the system scheme flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);

/** The single owner of the settings; controls and the tuning picker send patches. */
const store = createSettingsStore(loadSettings(localStorageOrNull(), DEFAULT_SETTINGS));
store.subscribe((s) => saveSettings(localStorageOrNull(), s));

// Transpose: the design's value box, as in Ready Set. It moves the MIDI from the sung pitch
// (the audio stays as recorded); a change elsewhere (the starling's song) shows in it.
const fmtSemis = (v: number) => (v > 0 ? `+${v}` : String(v));
const transposeBox = valueBox($("transpose"), {
  min: -24, max: 24, value: store.get().transpose, labelledBy: "transpose-label", format: fmtSemis,
  onChange: (v: number) => {
    if (store.get().transpose !== v) store.patch({ transpose: v });
    if (app.info) rememberTranspose(localStorageOrNull(), app.info.name, v);   // the take keeps it
  },
});
store.subscribe((s) => { if (transposeBox.value !== s.transpose) transposeBox.set(s.transpose); });

const renderer = createRenderer(
  api.render,
  (r, s) => {
    app.notes = r.notes;
    app.transpose = s.transpose;
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

const player = new Player(); // starts loading the instrument sounds now, well before Play
setOnNotesChanged(() => player.setNotes(app.notes));
// For scripted checks: the output level, and the player to listen in on.
Object.assign(window, { starlingPlayer: player, starlingApp: app });

async function togglePlay() {
  if (player.playing) player.stop();
  else player.play(startPoint(app.playhead ?? 0, app.info?.duration_s ?? 0));
  playBtn.setPressed(player.playing);
  tickPlayhead();
}

function tickPlayhead() {
  app.playhead = player.heard();
  rollInput.follow(app.playhead);
  redraw();
  if (player.playing) requestAnimationFrame(tickPlayhead);
  else playBtn.setPressed(false);
}

$("play").addEventListener("click", togglePlay);
// What you hear, and what leads the roll: the voice's line, the MIDI notes, or both.
document.querySelectorAll<HTMLInputElement>('input[name="listen"]').forEach((r) =>
  r.addEventListener("change", () => {
    app.listen = r.value as Listen;
    player.setMode(app.listen);
    redraw();
  }),
);
const recorder = new Recorder();
const takeName = $<HTMLInputElement>("take-name");
takeName.placeholder = nextTakeName([]);
/** What the next take is called: what was typed, else "Take 1", "Take 2"... */
const nameForTake = () => takeName.value.trim() || takeName.placeholder;

async function toggleRecord() {
  const btn = $<HTMLButtonElement>("record");
  if (!recorder.active) {
    player.stop();
    try {
      const t0 = performance.now();
      $("rec-status").hidden = false;
      await recorder.start((peak) => {
        $("rec-time").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
        $("rec-level").style.transform = `scaleX(${Math.min(1, peak)})`;
      });
      recordBtn.setPressed(true);
    } catch (e) {
      recordBtn.setPressed(false);
      $("rec-status").hidden = true;
      say(micError(e));
    }
    return;
  }
  btn.disabled = true;
  const { wav, seconds } = await recorder.stop();
  recordBtn.setPressed(false);
  $("rec-status").hidden = true;
  say(`Saving and analyzing ${seconds.toFixed(1)} s...`);
  try {
    const name = nameForTake();
    await opened(await api.uploadTake(name, wav, analyzing(name)));
    takeName.value = "";
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
  $("live-hint").hidden = !formats.includes("live");
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
  // Files made in the page are blob: URLs, which Chrome won't drag out: they were downloaded.
  for (const f of saved.files.filter((x) => !x.url.startsWith("blob:"))) {
    const h = handle(`Drag ${f.file_name}`, true);
    h.title = f.format === "als" ? "Drop into Ableton Live: the clip keeps each note's pitch curve" : "Drop into any music software";
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
    if (r.note) say(r.note);
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
const anchorSel = $<HTMLSelectElement>("anchor");
const sclFile = $<HTMLInputElement>("scl-file");
let presets: Preset[] = [];
let tuningView: TuningView = { active: null, custom: null, error: null };

function showTuning(v: TuningView) {
  tuningView = v;
  tuningSel.textContent = "";
  tuningSel.add(Object.assign(new Option("Standard", ""), { title: "12 equal steps per octave" }));
  for (const p of presets) tuningSel.add(new Option(p.name, `preset:${p.id}`));
  // A remembered built-in tuning starts as `custom` too; list it only once.
  if (v.custom && !presets.some((p) => p.scl === v.custom!.scl)) tuningSel.add(new Option(v.custom.name, "custom"));
  tuningSel.add(new Option("Load a Scala file…", "load"));
  const a = v.active;
  const isPreset = a && presets.some((p) => p.id === a.name && p.scl === a.scl);
  tuningSel.value = !a ? "" : isPreset ? `preset:${a.name}` : "custom";
  $("tuning-error").textContent = v.error ? `${v.error} (kept the previous tuning)` : "";
  showRoot();
}
/** The root note matters only to a tuning other than Standard, or when it is set to a custom
 * frequency: otherwise it stays out of sight, so the header reads simply. */
function showRoot() {
  $("root-note").hidden = !tuningView.active && anchorSel.value !== "custom";
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

// Root note (the anchor): the scale's first note, shown by name with its frequency on hover,
// or another frequency in Hz.
const anchorCustom = $<HTMLInputElement>("anchor-custom");
for (const n of anchorNotes()) anchorSel.add(Object.assign(new Option(n.label.split(" · ")[0], String(n.hz)), { title: `${formatHz(n.hz)} Hz` }));
anchorSel.add(new Option("Other frequency…", "custom"));
function showAnchor(hz: number) {
  const m = matchAnchor(hz);
  anchorSel.value = m ? String(m.hz) : "custom";
  anchorCustom.hidden = m !== null;
  anchorCustom.value = formatHz(hz);
  anchorSel.title = `${formatHz(hz)} Hz`;
  showRoot();
}
showAnchor(store.get().anchor_hz);
anchorSel.addEventListener("change", () => {
  if (anchorSel.value === "custom") {
    anchorCustom.hidden = false;
    anchorCustom.focus();
  } else store.patch({ anchor_hz: Number(anchorSel.value) });
  showRoot();
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
  say(r.info.warning ?? `${takeLabel(r.info.name)}: ${r.info.duration_s.toFixed(1)} s`);
  document.body.dataset.analysis = r.cached ? "cached" : "fresh";
  $("empty").hidden = true;
  $("delete-take").hidden = !api.canDelete;
  disarmDelete();                        // another take: the close starts unarmed
  document.body.toggleAttribute("data-take", true);   // play, listen, name and saving show
  await refreshTakes(r.info.name);
  player.stop();
  rollInput.clear();
  app.playhead = 0;
  app.scrub = null;
  await player.load(api.audioUrl());
  // A new take: the previous export no longer applies.
  $("saved-path").textContent = "";
  $("reveal").hidden = true;
  updateDrag();
  // Each take opens with its own Transpose: what it was last set to, else 0 for a new
  // recording and the built-in value for the starling's song.
  const t = transposeFor(localStorageOrNull(), r.info.name);
  if (store.get().transpose !== t) store.patch({ transpose: t });
  // The starling's song also opens with its own settings; your takes get yours back.
  const own = settingsOnOpen(localStorageOrNull(), store.get(), isSampleTake(r.info.name));
  if (own) store.patch(own);
  renderer.request(app.takeId, store.get());
}

// No mic handy: the starling's song, as in the demo, opened like any other take.
const SAMPLE_URL = new URL("../samples/starling-song.mp3", import.meta.url);
$("sample-link").addEventListener("click", async () => {
  if (recorder.active) return;
  say("Fetching a starling's song...");
  try {
    const { wav } = await sampleWav(SAMPLE_URL, browserDecode);
    await opened(await api.uploadTake(SAMPLE_NAME, wav, analyzing(SAMPLE_NAME)));
    say(`A starling, 2 octaves down. Its MIDI starts another 2 octaves down (Transpose ${fmtSemis(SAMPLE_TRANSPOSE)}). Song: Vrymaa on Freesound, CC0.`);
  } catch (err) {
    say((err as Error).message);
  }
});

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

// Deleting takes two clicks, as removing a kept cover in Rearranged: the first arms the
// close (accent, "Click again to delete"), the second deletes; left alone it disarms.
let deleteArm = 0;
function disarmDelete() {
  clearTimeout(deleteArm);
  const b = $("delete-take");
  b.removeAttribute("data-armed");
  b.title = "Delete this take";
}
$("delete-take").addEventListener("click", async () => {
  const name = app.info?.name;
  if (!name) return;
  const b = $("delete-take");
  if (!b.hasAttribute("data-armed")) {
    b.setAttribute("data-armed", "");
    b.title = `Click again to delete ${takeLabel(name)}`;
    deleteArm = window.setTimeout(disarmDelete, 4000);
    return;
  }
  disarmDelete();
  try {
    await api.deleteTake(name);
    forgetTranspose(localStorageOrNull(), name);
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
  document.body.toggleAttribute("data-take", false);
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
    const retry = Object.assign(document.createElement("button"), { className: "ds-button small", textContent: "Retry" });
    retry.onclick = () => location.reload();
    $("message").append(retry);
  });
