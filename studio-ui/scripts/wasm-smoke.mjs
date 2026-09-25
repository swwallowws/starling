// Load the built engine in Node (Chrome's WebAssembly engine) and analyze a
// phrase end to end with two pitch workers' worth of shares.
import { readFileSync } from "node:fs";
import { initSync, PitchWorker, Studio, tunings } from "../src/wasm-pkg/voxmpe_web.js";
import { phrase, wav16 } from "./wav.mjs";

initSync({ module: readFileSync(new URL("../src/wasm-pkg/voxmpe_web_bg.wasm", import.meta.url)) });
const model = readFileSync(new URL("../public-web/crepe-tiny.onnx", import.meta.url));

const studio = new Studio();
studio.load("smoke", wav16(phrase(44100), 44100));
const audio16 = studio.audio16();
const active = studio.active();
const half = Math.ceil(active.length / 2);
const parts = [active.slice(0, half), active.slice(half)].map((idx) => new PitchWorker(model).run(audio16, idx));
const results = new Float32Array(parts[0].length + parts[1].length);
results.set(parts[0]);
results.set(parts[1], parts[0].length);
const info = JSON.parse(studio.finish(results));
const notes = JSON.parse(studio.render("{}")).notes;
const mid = studio.export("{}", "mid");
if (!notes.length || info.duration_s < 1.3 || mid[0] !== 0x4d || JSON.parse(tunings()).length < 9) {
  console.error("smoke failed", { notes: notes.length, info, first: mid[0] });
  process.exit(1);
}
console.log(`smoke ok: ${notes.length} notes, ${info.duration_s.toFixed(1)} s, ${mid.length} byte .mid`);
