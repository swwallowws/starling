// The guided try page: sing, see the MIDI with its bends, switch to 53-EDO,
// play it back. A small slice of the studio on the same engine.
import "./try.css";
import { backend as api } from "../backend-impl";
import { drawRoll } from "../roll";
import { Player } from "../player";
import { Recorder, defaultTakeName } from "../recorder";
import { DEFAULT_SETTINGS, type LoadResp, type Preset, type RNote, type Settings, type TakeInfo } from "../types";
import { missingFeatures } from "../web/support";
import { demoShell } from "../../vendor/design/demoshell.js";
import { iconButton } from "../../vendor/design/iconbutton.js";
import { STEPS, micMessage, recordLimit } from "./steps";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const recordEl = $<HTMLButtonElement>("record");
const playEl = $<HTMLButtonElement>("play");
const canvas = $<HTMLCanvasElement>("roll");
const tuningInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="tuning"]')];
const smoothingRow = $<HTMLElement>("smoothing-row");
const smoothingInput = $<HTMLInputElement>("smoothing");
const smoothingVal = $<HTMLElement>("smoothing-val");

const say = (text: string) => { $("message").textContent = text; };

// Record/Stop and Play are icon toggles; the record icon swaps to stop while
// recording, and the play icon swaps to pause while playing. Space and R are
// wired below through demoShell's primary/keys, routed through toggle() so
// the key and the click run the same handler.
const record = iconButton(recordEl, {
  onPress: (recording) => (recording ? void startRecording() : void finishRecording()),
});
const play = iconButton(playEl, {
  onPress: (playing) => (playing ? startPlayback() : stopPlayback()),
});
// A disabled placeholder: the tooltip carries the "coming soon" note.
iconButton($<HTMLButtonElement>("sample"));

const { rail } = demoShell($("demo"), {
  product: "voxmpe",
  title: "Turn a voice into notes.",
  intro: "A small slice of the studio, on the same engine.",
  steps: STEPS,
  full: { label: "studio", href: "../" },
  endText: "That's the idea. There's more inside: every setting, more tunings, and .mid or Ableton Live export.",
  onReset: startOver,
  primary: { toggle: () => play.toggle(), label: "play" },
  keys: { r: { run: () => record.toggle(), label: "record" } },
});

const recorder = new Recorder();
/** Made on the first take, after a click, so the page never starts audio on its own. */
let player: Player | null = null;
let take: { id: number; info: TakeInfo } | null = null;
let notes: RNote[] = [];
let playhead: number | null = null;
let presets: Preset[] | null = null;
let tuning: Preset | null = null;
let smoothing = DEFAULT_SETTINGS.smoothing;
let renderSeq = 0;
let stopping = false;

/** Same control as the studio's Expression > Smoothing slider: 0..100%, --fill paints the track. */
function paintSmoothing() {
  const pct = Number(smoothingInput.value);
  smoothingInput.style.setProperty("--fill", `${pct}%`);
  smoothingVal.textContent = `${pct}%`;
}

function draw() {
  if (take) drawRoll(canvas, take.info, notes, playhead);
}
window.addEventListener("resize", draw);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

function setTakeControls(on: boolean) {
  for (const i of tuningInputs) i.disabled = !on;
  playEl.disabled = !on || notes.length === 0;
}

paintSmoothing();

if (api.kind === "web" && missingFeatures().length > 0) {
  say(`This browser is missing ${missingFeatures().join(", ")}. Try a current Chrome, Edge, Firefox or Safari.`);
  recordEl.disabled = true;
}

// Record/Stop is driven by the icon button above (click or the R key), which
// flips its own pressed state before calling onPress; the take stops by
// itself at the limit too, so finishRecording() also runs off a click.
async function startRecording() {
  player?.stop();
  say("");
  const t0 = performance.now();
  try {
    await recorder.start(() => {
      const ms = performance.now() - t0;
      $("rec-status").textContent = `${(ms / 1000).toFixed(1)} s`;
      if (recordLimit(ms)) void finishRecording();
    });
  } catch (e) {
    record.setPressed(false);
    say(micMessage(e));
  }
}

async function finishRecording() {
  if (stopping || !recorder.active) return;
  stopping = true;
  recordEl.disabled = true;
  record.setPressed(false); // also runs when the limit auto-stops it, not just a click
  try {
    const { wav, seconds } = await recorder.stop();
    $("rec-status").textContent = "";
    say(`Analyzing ${seconds.toFixed(1)} s...`);
    const r = await api.uploadTake(defaultTakeName(new Date()), wav, (f) => say(`Analyzing... ${Math.round(f * 100)}%`));
    await open(r);
  } catch (e) {
    say((e as Error).message);
  } finally {
    stopping = false;
    recordEl.disabled = false;
  }
}

async function open(r: LoadResp) {
  take = { id: r.take_id, info: r.info };
  notes = [];
  playhead = null;
  player ??= new Player();
  await player.load(api.audioUrl());
  $("empty").hidden = true;
  smoothingRow.hidden = false;
  $("rec-status").textContent = ""; // the meter's last block can land after Stop
  rail.done("sing");
  presets ??= await api.listTunings().catch(() => null);
  await render();
  setTakeControls(true);
  if (notes.length === 0) {
    say(r.info.warning ?? "No notes found in that take. Try singing a little longer or louder.");
    return;
  }
  say(`${notes.length} notes. The line through each note is its bend curve.`);
  rail.done("midi");
}

/** Render the open take with the chosen tuning; false when a newer render took over. */
async function render(): Promise<boolean> {
  if (!take) return false;
  const mine = ++renderSeq;
  const s: Settings = { ...DEFAULT_SETTINGS, tuning_name: tuning?.id ?? null, tuning_scl: tuning?.scl ?? null, smoothing };
  const r = await api.render(take.id, s);
  if (mine !== renderSeq) return false;
  notes = r.notes;
  // What the roll shows, for the walk script: each note's MIDI pitch, its
  // center, and where it sounds (pitch plus its median bend).
  canvas.dataset.notes = JSON.stringify(notes.map((n) => [n.pitch, n.center, n.pitch + median(n.bend.map(([, st]) => st))]));
  player?.setNotes(notes);
  draw();
  return true;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

for (const input of tuningInputs) {
  input.addEventListener("change", async () => {
    if (!input.checked) return;
    const id = input.value;
    tuning = id ? presets?.find((p) => p.id === id) ?? null : null;
    if (id && !tuning) {
      say("That tuning didn't load. Try again in a moment.");
      return;
    }
    try {
      if (!(await render())) return;
    } catch (e) {
      say((e as Error).message);
      return;
    }
    say(tuning ? `${notes.length} notes in 53-EDO, the 53 commas per octave of Turkish makam.` : `${notes.length} notes in 12-TET.`);
    playEl.disabled = notes.length === 0;
    if (tuning) rail.done("tuning");
  });
}

// Smoothing: the studio's own Expression control, reused as is. Free play, not a rail step.
smoothingInput.addEventListener("input", async () => {
  smoothing = Number(smoothingInput.value) / 100;
  paintSmoothing();
  try {
    await render();
  } catch (e) {
    say((e as Error).message);
  }
});

/** Set on a manual Stop click so tick() doesn't mark the step done for an early stop. */
let manualStop = false;

// Play/Stop is driven by the icon button above (click or Space). The
// player's AudioContext resumes inside that click, so the first press sounds.
function startPlayback() {
  if (!player || !take) {
    play.setPressed(false);
    return;
  }
  manualStop = false;
  player.play(0);
  requestAnimationFrame(tick);
}

function stopPlayback() {
  if (!player || !take) return;
  manualStop = true;
  player.stop();
}

function tick() {
  if (!player || !take) return;
  if (player.playing) {
    playhead = player.position();
    draw();
    requestAnimationFrame(tick);
    return;
  }
  // The player now always stops itself at the real end (see player.ts), so reaching here with
  // manualStop unset means it played through, not that this loop guessed the end.
  playhead = null;
  play.setPressed(false);
  draw();
  if (!manualStop) rail.done("play");
}

function startOver() {
  if (recorder.active && !stopping) void recorder.stop();
  record.setPressed(false);
  $("rec-status").textContent = "";
  player?.stop();
  take = null;
  notes = [];
  playhead = null;
  tuning = null;
  tuningInputs[0].checked = true;
  smoothing = DEFAULT_SETTINGS.smoothing;
  smoothingInput.value = String(smoothing * 100);
  paintSmoothing();
  smoothingRow.hidden = true;
  setTakeControls(false);
  play.setPressed(false);
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  $("empty").hidden = false;
  say("");
}
