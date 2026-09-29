import { CHANNELS, Scheduler, VOLUME, BEND_RANGE, type SynthPort } from "./voices";
import { PROGRAM, soundfontBytes } from "./sound";
import { heardTime } from "../vendor/design/playhead.js";
import type { WorkletSynthesizer } from "../vendor/design/sound/spessasynth/spessasynth_lib.min.js";
import type { RNote } from "./types";

type Mode = "voice" | "midi" | "both";

const PROCESSOR = new URL("../vendor/design/sound/spessasynth/spessasynth_processor.min.js", import.meta.url).href;
/** How far ahead the notes are handed to the synth (s), and how often (ms). A hidden tab's
 * timers slow to about once a second, so it looks further ahead. */
const AHEAD = 0.25;
const AHEAD_HIDDEN = 1.5;
const TICK_MS = 25;
/** The instruments come out of the synth at about half the old oscillator's level; this brings
 * a sung line back to about 0.25 peak, level with a typical take. */
const MIDI_GAIN = 1.8;

/** The take's audio and its notes, played together. The notes sound through spessasynth with
 * the shared General MIDI bank (see voices.ts for how the curves become MIDI). */
export class Player {
  private ctx = new AudioContext();
  private out = this.ctx.createGain();
  private voiceBus = this.ctx.createGain();
  private midiBus = this.ctx.createGain();
  private meter = this.ctx.createAnalyser();
  private buffer: AudioBuffer | null = null;
  private voice: AudioBufferSourceNode | null = null;
  private synth: WorkletSynthesizer | null = null;
  private sched: Scheduler | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notes: RNote[] = [];
  private startedAt = 0;
  private from = 0;
  private isPlaying = false;
  /** Resolves once the instruments can sound (never rejects: a failed load leaves the voice alone). */
  readonly ready: Promise<boolean>;

  constructor() {
    this.voiceBus.connect(this.out);
    this.midiBus.connect(this.out);
    this.out.connect(this.ctx.destination);
    this.out.connect(this.meter);
    this.setMode("midi");
    this.ready = this.initSynth().then(
      () => true,
      (e) => { console.warn("MIDI playback unavailable:", e); return false; },
    );
  }

  private async initSynth() {
    if (!this.ctx.audioWorklet) throw new Error("no AudioWorklet");
    const [lib, bytes] = await Promise.all([
      import("../vendor/design/sound/spessasynth/spessasynth_lib.min.js"),
      soundfontBytes(),
      this.ctx.audioWorklet.addModule(PROCESSOR),
    ]);
    const synth = new lib.WorkletSynthesizer(this.ctx);
    synth.connect(this.midiBus);
    await synth.soundBankManager.addSoundBank(bytes.slice(0), "main");
    await synth.isReady;
    for (const ch of CHANNELS) {
      synth.pitchWheelRange(ch, BEND_RANGE);
      synth.controllerChange(ch, 7, VOLUME);
      synth.programChange(ch, PROGRAM);
    }
    const at = (time: number) => ({ time });
    const port: SynthPort = {
      bend: (ch, v, t) => synth.pitchWheel(ch, v, at(t)),
      cc: (ch, cc, v, t) => synth.controllerChange(ch, cc, v, at(t)),
      on: (ch, key, vel, t) => synth.noteOn(ch, key, vel, at(t)),
      off: (ch, key, t) => synth.noteOff(ch, key, at(t)),
    };
    this.synth = synth;
    this.sched = new Scheduler(port);
    if (this.isPlaying) this.scheduleMidi(); // Play came first: join in where the playhead is
  }

  async load(url: string) {
    this.stop();
    const bytes = await (await fetch(url)).arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(bytes);
  }

  get playing() { return this.isPlaying; }

  /** Where the listener is, for drawing the playhead: playing, the position less the output's
   * delay (200 ms or more on Bluetooth), held at the start point until its sound arrives. */
  heard() {
    return this.isPlaying ? heardTime(this.position(), this.from, this.ctx) : this.from;
  }

  position() {
    return this.isPlaying ? this.from + (this.ctx.currentTime - this.startedAt) : this.from;
  }

  setMode(m: Mode) {
    this.voiceBus.gain.value = m === "midi" ? 0 : 1;
    this.midiBus.gain.value = m === "voice" ? 0 : MIDI_GAIN;
  }

  /** The output's peak right now (0 to 1): 0 means silence. */
  level() {
    const buf = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(buf);
    return buf.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  }

  /** For checks: the context and the instruments' bus, to listen in on. */
  monitor() { return { ctx: this.ctx, midi: this.midiBus as AudioNode }; }

  play(from: number) {
    if (!this.buffer) return;
    this.stop();
    void this.ctx.resume();
    this.from = from;
    this.startedAt = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.voiceBus);
    // Fires on natural end and on an explicit stop() alike. this.voice === source rules out a stale
    // event from a source a later seek/pause already replaced; isPlaying rules out our own stop().
    source.onended = () => { if (this.isPlaying && this.voice === source) this.stop(); };
    source.start(this.startedAt, from);
    this.voice = source;
    this.isPlaying = true;
    this.scheduleMidi();
  }

  stop() {
    this.from = this.position();
    this.isPlaying = false;
    try { this.voice?.stop(); } catch { /* already stopped */ }
    this.voice = null;
    this.stopMidi();
  }

  /** Swap in new notes; if playing, reschedule from the playhead. */
  setNotes(notes: RNote[]) {
    this.notes = notes;
    if (this.isPlaying) {
      this.stopMidi();
      this.scheduleMidi();
    }
  }

  private stopMidi() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.sched?.cancel(this.ctx.currentTime);
  }

  private scheduleMidi() {
    const sched = this.sched;
    if (!sched) return; // still loading: initSynth starts it
    const now = this.ctx.currentTime;
    sched.start(this.notes, this.position(), now);
    const pump = () => sched.pump(this.ctx.currentTime, document.hidden ? AHEAD_HIDDEN : AHEAD);
    pump();
    this.timer = setInterval(pump, TICK_MS);
  }
}
