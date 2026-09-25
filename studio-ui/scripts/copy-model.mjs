// Copy CREPE tiny into the web build's public folder, or explain how to get it.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const from = new URL("../../models/crepe-tiny.onnx", import.meta.url);
const dir = new URL("../public-web/", import.meta.url);
if (!existsSync(from)) {
  console.error("models/crepe-tiny.onnx is missing. See models/README.md (python scripts/export_crepe.py tiny).");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
copyFileSync(from, new URL("crepe-tiny.onnx", dir));
console.log("copied crepe-tiny.onnx");
