import { fromTime, noteAutomation, releaseLevel } from "./synth";
import type { RNote } from "./types";

type Mode = "voice" | "midi" | "both";

export class Player {
  private ctx = new AudioContext();
  private voiceBus = this.ctx.createGain();
  private midiBus = this.ctx.createGain();
  private buffer: AudioBuffer | null = null;
  private voice: AudioBufferSourceNode | null = null;
  private oscs: OscillatorNode[] = [];
  private notes: RNote[] = [];
  private startedAt = 0;
  private from = 0;
  private isPlaying = false;

  constructor() {
    this.voiceBus.connect(this.ctx.destination);
    this.midiBus.connect(this.ctx.destination);
    this.setMode("midi");
  }

  async load(url: string) {
    this.stop();
    const bytes = await (await fetch(url)).arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(bytes);
  }

  get playing() { return this.isPlaying; }

  position() {
    return this.isPlaying ? this.from + (this.ctx.currentTime - this.startedAt) : this.from;
  }

  setMode(m: Mode) {
    this.voiceBus.gain.value = m === "midi" ? 0 : 1;
    this.midiBus.gain.value = m === "voice" ? 0 : 1;
  }

  play(from: number) {
    if (!this.buffer) return;
    this.stop();
    void this.ctx.resume();
    this.from = from;
    this.startedAt = this.ctx.currentTime;
    this.voice = this.ctx.createBufferSource();
    this.voice.buffer = this.buffer;
    this.voice.connect(this.voiceBus);
    this.voice.onended = () => { if (this.isPlaying && this.position() >= this.buffer!.duration) this.stop(); };
    this.voice.start(this.startedAt, from);
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
    for (const o of this.oscs) { try { o.stop(); } catch { /* already stopped */ } }
    this.oscs = [];
  }

  private scheduleMidi() {
    const now = this.ctx.currentTime;
    const pos = this.position();
    const at = (t: number) => now + (t - pos);
    for (const n of this.notes) {
      const a = fromTime(noteAutomation(n), pos);
      if (!a) continue;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.connect(g).connect(this.midiBus);
      g.gain.setValueAtTime(0, at(a.start));
      a.freq.forEach(([t, hz], i) => (i ? osc.frequency.linearRampToValueAtTime(hz, at(t)) : osc.frequency.setValueAtTime(hz, at(a.start))));
      a.gain.forEach(([t, v], i) => (i ? g.gain.linearRampToValueAtTime(v, at(t)) : g.gain.linearRampToValueAtTime(v, at(a.start) + 0.005)));
      g.gain.setValueAtTime(releaseLevel(a), at(a.end) - 0.01);
      g.gain.linearRampToValueAtTime(0, at(a.end));
      osc.start(at(a.start));
      osc.stop(at(a.end) + 0.02);
      this.oscs.push(osc);
    }
  }
}
