// Drive the built site (npm run build:web first) in headless Chrome:
// open a WAV, see notes, move a slider, save both files, reopen from cache.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { phrase, wav16 } from "./wav.mjs";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Scratch stays inside the project (gitignored), not the OS temp folder.
const dir = fileURLToPath(new URL("../.e2e/", import.meta.url));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const wavPath = join(dir, "e2e phrase.wav");
writeFileSync(wavPath, wav16(phrase(44100), 44100));

const server = spawn("npx", ["vite", "preview", "--mode", "web", "--port", "4318", "--strictPort"], { stdio: "pipe" });
await new Promise((ok) => server.stdout.on("data", (d) => String(d).includes("4318") && ok()));
const fail = (msg) => {
  console.error(`e2e failed: ${msg}`);
  server.kill();
  process.exit(1);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  const logs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("requestfailed", (r) => logs.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => r.status() >= 400 && logs.push(`${r.status()}: ${r.url()}`));
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  await page.goto("http://localhost:4318/");
  // The page is ready once startup has filled the take picker (the web backend
  // opens IndexedDB with a top-level await, after the load event).
  await page.waitForFunction(() => document.querySelectorAll("#takes option").length >= 2, { timeout: 20000 });

  const notes = () => page.$eval("#note-count", (e) => e.textContent);
  const waitNotes = () =>
    page
      .waitForFunction(
        () => {
          const t = document.getElementById("note-count").textContent;
          return /\d+ notes/.test(t) && !t.startsWith("0 ");
        },
        { timeout: 60000 },
      )
      .catch(async () => {
        const message = await page.$eval("#message", (e) => e.textContent);
        const started = await page.$eval("#privacy", (e) => !e.hidden);
        fail(`no notes. page script ran: ${started}. message: "${message}"\n${[...errors, ...logs].join("\n")}`);
      });

  const input = await page.$("#wav-file");
  await input.uploadFile(wavPath);
  await waitNotes();
  if ((await page.evaluate(() => document.body.dataset.analysis)) !== "fresh") fail("first open should analyze");
  console.log("opened:", await notes());

  const flags = () => page.$eval("#controls code", (e) => e.textContent);
  const before = await flags();
  await page.$eval("#controls input[type=range]", (el) => {
    el.value = String(Number(el.value) + 50);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction((b) => document.querySelector("#controls code").textContent !== b, { timeout: 10000 }, before);
  console.log("re-rendered:", await flags());

  await page.$$eval('input[name="format"]', (boxes) =>
    boxes.forEach((b) => {
      if (!b.checked) b.click();
    }),
  );
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("saved-path").textContent.includes(".als"), { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1000));
  const saved = readdirSync(dir)
    .filter((f) => f.endsWith(".mid") || f.endsWith(".als"))
    .sort();
  if (saved.length !== 2) fail(`expected .mid and .als downloads, got ${saved}`);
  console.log("downloaded:", saved.join(", "));

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#takes option").length > 2, { timeout: 10000 });
  const name = await page.$eval("#takes", (s) => [...s.options].map((o) => o.value).find((v) => v.endsWith(".wav")));
  await page.select("#takes", name);
  await waitNotes();
  if ((await page.evaluate(() => document.body.dataset.analysis)) !== "cached") fail("reopening should use the cache");
  console.log("reopened from cache:", name);
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  console.log("e2e ok");
} finally {
  await browser.close();
  server.kill();
}
