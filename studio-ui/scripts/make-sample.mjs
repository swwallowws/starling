// Make the try page's sample take from the processed research cut.
//
// Source: Freesound 737756 "Bird - Common starling" by Vrymaa (CC0), 0-8.5 s,
// from the HQ preview, made mono 44.1 kHz, high-passed at 1.2 kHz and moved
// down 2 octaves with its duration kept (research/starling/eval_clean.py):
//
//   ffmpeg -i 737756-hq.mp3 -ac 1 -ar 44100 -c:a pcm_s16le fs-737756.wav
//   ffmpeg -i fs-737756.wav -af "highpass=f=1200:poles=2,highpass=f=1200:poles=2,asetrate=11025,aresample=44100,atempo=2,atempo=2" -c:a pcm_s16le fs-737756.hp_shift2.wav
//   ffmpeg -ss 0 -t 8.5 -i fs-737756.hp_shift2.wav -c:a pcm_s16le pick-fs-737756-0-8.5.hp_shift2.wav
//
// This script takes that last file (research/ stays local, it is gitignored),
// keeps its last 6 s (2.5 to 8.5 s of the cut, picked by ear by Bengisu),
// adds a short fade in and out, and encodes a small mono MP3, which every
// browser's decodeAudioData reads. The try page decodes it and hands it to the
// engine as a WAV, the same path as a recorded take.
//
// usage: node scripts/make-sample.mjs [path/to/pick-fs-737756-0-8.5.hp_shift2.wav]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const START = 2.5;
const END = 8.5;
const DURATION = END - START;
const FADE_IN = 0.03;
const FADE_OUT = 0.3;

const src = process.argv[2] ?? fileURLToPath(new URL("../../research/starling/pick-fs-737756-0-8.5.hp_shift2.wav", import.meta.url));
const dir = new URL("../samples/", import.meta.url);
const out = fileURLToPath(new URL("starling-song.mp3", dir));
if (!existsSync(src)) {
  console.error(`${src} is missing. Make it with research/starling/eval_clean.py (see the comment at the top of this script).`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const args = [
  "-hide_banner", "-loglevel", "error", "-y",
  "-i", src,
  "-af", `atrim=start=${START}:end=${END},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${DURATION - FADE_OUT}:d=${FADE_OUT}`,
  "-ac", "1", "-ar", "24000",
  "-c:a", "libmp3lame", "-b:a", "48k",
  "-map_metadata", "-1",
  out,
];
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`wrote samples/starling-song.mp3 (${statSync(out).size} bytes)`);
