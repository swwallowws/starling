// Check the studio's sampled MIDI playback in headless Chrome, against the built site served at
// --url (default http://localhost:4318/, `npm run preview:web`):
//   - a take with a glide plays audibly (the player's level meter),
//   - the pitch of what sounds follows each note's pitch curve (f0 of the recorded output vs the
//     automation, in cents),
//   - a seek jumps there and plays the note under the new playhead, and Stop goes quiet.
// Usage: node scripts/sound-check.mjs [--url http://localhost:4318/] [--program 53]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { wav16 } from "./wav.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const URL_ = flag("--url", "http://localhost:4318/");
const PROGRAM = flag("--program", "53");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = fileURLToPath(new URL("../.e2e/sound/", import.meta.url));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// The take: a steady A3, a 4-semitone glide up, a hold, a gap, then a note between 12-TET keys.
const SR = 44100;
function take() {
  const out = new Float32Array(Math.round(SR * 3.4));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let st = null;
    if (t < 0.8) st = 0;
    else if (t < 1.4) st = (4 * (t - 0.8)) / 0.6;
    else if (t < 2.2) st = 4;
    // 45 cents above D3, with a ±30 cent vibrato at 5 Hz: a curve inside one note.
    else if (t >= 2.4 && t < 3.3) st = 5.45 + 0.3 * Math.sin(2 * Math.PI * 5 * t);
    if (st === null) continue;
    const hz = 220 * 2 ** (st / 12);
    phase += (2 * Math.PI * hz) / SR;
    out[i] = 0.3 * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
  }
  return out;
}
const wavPath = join(dir, "glide check.wav");
writeFileSync(wavPath, wav16(take(), SR));

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed = true; };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "warning" || m.type() === "error" ? errors.push(m.text()) : null);
  await page.evaluateOnNewDocument((p) => localStorage.setItem("starling.instrument", p), PROGRAM);
  await page.goto(URL_);
  await page.waitForFunction(() => document.querySelectorAll("#takes option").length >= 2, { timeout: 20000 });
  check((await page.$eval("#instrument", (s) => s.value)) === PROGRAM, `instrument picker shows the remembered program ${PROGRAM}`);
  const input = await page.$("#wav-file");
  await input.uploadFile(wavPath);
  await page.waitForFunction(() => /[1-9]\d* notes/.test(document.getElementById("note-count").textContent), { timeout: 60000 });
  const loaded = await page.evaluate(() => window.starlingPlayer.ready);
  check(loaded, "soundfont and synth loaded");

  // Record the instruments' bus with an AudioWorklet that stamps each block with the audio clock.
  await page.evaluate(async () => {
    const p = window.starlingPlayer;
    const { ctx, midi } = p.monitor();
    const code = `registerProcessor("rec", class extends AudioWorkletProcessor {
      constructor() { super(); this.buf = []; this.t0 = 0; }
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) { if (!this.buf.length) this.t0 = currentTime; this.buf.push(ch.slice()); }
        if (this.buf.length >= 32) { this.port.postMessage([this.t0, this.buf]); this.buf = []; }
        return true;
      }
    });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ctx, "rec");
    window.recorded = [];
    node.port.onmessage = (e) => window.recorded.push(e.data);
    midi.connect(node);
    node.connect(ctx.destination); // silent: it outputs nothing, but stays pulled
    window.sampleRate = ctx.sampleRate;
  });
  await page.click('input[name="listen"][value="midi"]');
  const notes = await page.evaluate(() => window.starlingPlayer.notes);
  console.log(`take: ${notes.length} notes`, notes.map((n) => `${n.pitch}@${n.start.toFixed(2)}-${n.end.toFixed(2)}`).join(" "));

  // Play from the start; watch the level meter while it plays.
  await page.click("#play");
  const levels = [];
  const played = await page.evaluate(() => ({ startedAt: window.starlingPlayer.startedAt, from: window.starlingPlayer.from }));
  for (let i = 0; i < 37; i++) {
    await new Promise((r) => setTimeout(r, 100));
    levels.push(await page.evaluate(() => window.starlingPlayer.level()));
  }
  const peak = Math.max(...levels);
  check(peak > 0.05, `audible: output peak ${peak.toFixed(3)} while playing`);
  check(!(await page.evaluate(() => window.starlingPlayer.playing)), "stopped by itself at the end of the take");

  // Play again from 0.3 s, then seek to 1.8 s (the held top of the glide) while playing, as a
  // click on the roll does.
  await page.evaluate(() => window.starlingPlayer.play(0.3));
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => window.starlingPlayer.play(1.8));
  const seek = await page.evaluate(() => ({ startedAt: window.starlingPlayer.startedAt, from: window.starlingPlayer.from, pos: window.starlingPlayer.position() }));
  check(Math.abs(seek.pos - 1.8) < 0.05, `seek: playhead at ${seek.pos.toFixed(3)} s`);
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => window.starlingPlayer.stop());
  const stoppedAt = await page.evaluate(() => window.starlingPlayer.monitor().ctx.currentTime);
  await new Promise((r) => setTimeout(r, 600));
  const blocks = await page.evaluate(() => window.recorded.map(([t0, bufs]) => [t0, bufs.map((b) => Array.from(b))]));
  const sr = await page.evaluate(() => window.sampleRate);

  // One timeline of samples on the audio clock.
  const t0 = blocks[0][0];
  const total = blocks.reduce((n, [, bufs]) => n + bufs.length * 128, 0);
  const pcm = new Float32Array(Math.round((blocks.at(-1)[0] - t0) * sr) + total);
  for (const [t, bufs] of blocks) {
    let at = Math.round((t - t0) * sr);
    for (const b of bufs) { pcm.set(b, at); at += b.length; }
  }
  writeFileSync(join(dir, "midi-out.wav"), wav16(pcm, sr));
  const sampleAt = (ctxTime) => Math.round((ctxTime - t0) * sr);

  // f0 by normalised autocorrelation over a 40 ms window, refined by parabolic interpolation.
  function f0(center) {
    const n = Math.round(0.025 * sr), s = sampleAt(center) - n / 2;
    const x = pcm.subarray(s, s + n);
    let best = 0, bestLag = 0;
    const r = [];
    const minLag = Math.floor(sr / 800), maxLag = Math.ceil(sr / 80);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0, e1 = 0, e2 = 0;
      for (let i = 0; i + lag < n; i++) { num += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; }
      r[lag] = num / Math.sqrt(e1 * e2 || 1);
    }
    // The first peak above 0.9 of the maximum: the period, not a multiple of it.
    for (let lag = minLag; lag <= maxLag; lag++) best = Math.max(best, r[lag] ?? 0);
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (r[lag] > 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { bestLag = lag; break; }
    }
    if (!bestLag) return null;
    const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    return sr / (bestLag + shift);
  }
  const lerp = (pts, t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) {
      const [ta, va] = pts[i - 1], [tb, vb] = pts[i];
      return tb === ta ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
    }
    return pts.at(-1)[1];
  };
  // The automation's pitch (MIDI semitones) at song time t, averaged over the analysis window.
  function expected(t) {
    // Clear of each note's attack and of its end.
    const n = notes.find((x) => x.start + 0.06 <= t && t <= x.end - 0.03);
    if (!n) return null;
    const pts = n.bend.length ? n.bend : [[n.start, 0]];
    let sum = 0;
    for (let k = -3; k <= 3; k++) sum += n.pitch + lerp(pts, t + k * 0.004);
    return sum / 7;
  }
  const cents = (hz, midi) => 1200 * Math.log2(hz / (440 * 2 ** ((midi - 69) / 12)));

  const report = (label, run, t1, t2) => {
    const errs = [];
    for (let t = t1; t < t2; t += 0.02) {
      const want = expected(t);
      if (want === null) continue;
      const ctxTime = run.startedAt + (t - run.from);
      const hz = f0(ctxTime);
      if (!hz) continue;
      errs.push({ t, want, err: cents(hz, want) });
    }
    const abs = errs.map((e) => Math.abs(e.err)).sort((a, b) => a - b);
    const med = abs[Math.floor(abs.length / 2)], p90 = abs[Math.floor(abs.length * 0.9)];
    console.log(`${label}: ${errs.length} points, |error| median ${med?.toFixed(1)} c, 90th ${p90?.toFixed(1)} c, max ${abs.at(-1)?.toFixed(1)} c`);
    const worst = [...errs].sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 4);
    for (const e of worst) console.log(`  worst: t=${e.t.toFixed(2)} want ${e.want.toFixed(2)} st, off ${e.err.toFixed(1)} c`);
    return { med, p90, n: errs.length, errs };
  };
  const first = report("from the start", played, 0.1, 3.35);
  // How late the sound runs behind the curve: the shift that best fits the vibrato.
  let lag = { d: 0, rms: Infinity };
  for (let d = -0.03; d <= 0.03; d += 0.001) {
    let s = 0, k = 0;
    for (let t = 2.5; t < 3.25; t += 0.02) {
      const want = expected(t - d), hz = f0(played.startedAt + (t - played.from));
      if (want !== null && hz) { s += cents(hz, want) ** 2; k++; }
    }
    if (k && Math.sqrt(s / k) < lag.rms) lag = { d, rms: Math.sqrt(s / k) };
  }
  console.log(`best fit: sound ${(lag.d * 1000).toFixed(0)} ms behind the curve, rms ${lag.rms.toFixed(1)} c`);
  const vib = first.errs.filter((e) => e.t > 2.4);
  const swing = Math.max(...vib.map((e) => e.want)) - Math.min(...vib.map((e) => e.want));
  const vibMed = vib.map((e) => Math.abs(e.err)).sort((a, b) => a - b)[Math.floor(vib.length / 2)];
  check(vib.length >= 20 && swing > 0.4 && vibMed < 5 && vib.every((e) => Math.abs(e.err) < 15),
    `vibrato note (45 c off 12-TET, swinging ${(swing * 100).toFixed(0)} c): median ${vibMed.toFixed(1)} c, every point within 15 c`);
  check(Math.abs(lag.d) <= 0.006 && lag.rms < 5, "the sound keeps time with the curve (within 6 ms, rms < 5 c)");
  check(first.n >= 15 && first.med < 5 && first.p90 < 10, "pitch follows the curve through the glide (median < 5 c, 90% < 10 c)");
  const after = report("after the seek", seek, 1.9, 2.25);
  check(after.n >= 3 && after.med < 5, "after the seek, the held note sounds at its pitch");

  // Quiet after Stop: the last 300 ms of the recording.
  const tail = pcm.subarray(sampleAt(stoppedAt + 0.25), sampleAt(stoppedAt + 0.55));
  const tailPeak = tail.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  check(tailPeak < 0.01, `quiet after Stop: peak ${tailPeak.toFixed(4)}`);
  check(errors.length === 0, `no page errors or warnings${errors.length ? ": " + errors.join("; ") : ""}`);

  // The try page plays through the same player: the starling's song, audibly.
  const trial = await browser.newPage();
  await trial.goto(new URL("try/", URL_).href);
  await trial.click("#sample");
  await trial.waitForFunction(() => !document.getElementById("play").disabled, { timeout: 60000 });
  check(await trial.evaluate(() => window.starlingPlayer.ready), "try page: synth loaded");
  await trial.click("#play");
  let tryPeak = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    tryPeak = Math.max(tryPeak, await trial.evaluate(() => window.starlingPlayer.level()));
  }
  check(tryPeak > 0.05, `try page: audible, output peak ${tryPeak.toFixed(3)}`);
} finally {
  await browser.close();
}
console.log(failed ? "sound check FAILED" : "sound check ok");
process.exit(failed ? 1 : 0);
