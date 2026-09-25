# voxmpe web: the studio in the browser

Date: 2026-09-25. Status: approved design, before implementation plan.

## Goal

Open a URL, record or drop a WAV, get notes within seconds, tune by ear, and
save `.mid` or `.als`, with nothing to install. The same studio UI as the local
version, running the same Rust engine compiled to WebAssembly.

**Who it is for, in order:** Bengisu's own tool, usable from any machine, with
takes and settings kept between visits (primary); a demo visitors can try on the
showcase site (secondary, only where it costs little).

**Kept as is:** the native local studio and CLI, with the full CREPE model.
The browser version uses CREPE tiny.

## Evidence this is viable

Measured 2026-09-25 (throwaway spike, Node 24 = Chrome's V8), 10 s of audio:

| | tiny | full |
|---|---|---|
| native, 1 thread | 0.62x realtime | 5.1x |
| WASM | 1.07x | 27x |
| WASM + SIMD | 0.73x | 14x |
| WASM + SIMD, 4 parallel | 0.21x | |
| WASM + SIMD, 8 parallel | 0.15x | |

A 60 s take analyzes once in roughly 10 to 15 s; every re-render after that is
milliseconds. Download: about 2.4 MB compressed engine plus the 2 MB tiny model.
Tiny vs full (earlier spike, 6 real takes): median 4.3 cents apart, 86% of full's
notes matched by tiny.

## Architecture

One engine, one UI, two backends. The UI's only server contact is `api.ts`,
which becomes an interface with a server implementation (today's) and a
WebAssembly implementation.

### Core change (`voxmpe-core`)

`CrepeModel::track_gated` is split into three steps, which the native path
still chains, with its threads:

1. `prepare(audio, sample_rate, rms_floor)`: resample to 16 kHz, count frames,
   list the frames loud enough to analyze. Cheap.
2. `CrepeModel::pitch_frames(audio16, frame_indices)`: frame and normalize only
   the listed frames, run the model in batches of 32, return `(f0_hz,
   confidence)` per listed frame. The slow step; each pitch worker runs a share.
3. `assemble(...)`: results back in frame order, plus the loudness and centroid
   features and the voicing gate, giving exactly the `Frames` that `track()`
   returns.

Workers receive the 16 kHz audio once (about 4 MB per minute) and frame their
own indices, not the per-frame windows (about 24 MB per minute).

### `voxmpe` crate

The server and CLI (`tiny_http`, `clap`, `include_dir`, file access) move behind
a default `native` feature. Without it, `settings`, `tunings`, `scala`,
`retune`, `expression`, `als` and the SMF export compile to `wasm32`. The
logic `Session` runs per render and export (transcribe, retune, shape, export)
is reachable without the server so both backends call the same code.

### New crate `crates/voxmpe-web` (wasm-bindgen)

Two roles, each in its own Web Worker:

- **Pitch worker** (one per core, clamped to 2..8): loads CREPE tiny from bytes
  once, then turns `(audio16, frame indices)` into `(f0, confidence)` pairs.
- **Studio worker** (one): holds the open take.
  - `load(wav)` decodes, prepares, returns audio16 and the index shares.
  - `finish(results)` assembles `Frames`, returns the take info (contour,
    loudness), and returns the `Frames` for caching.
  - `restore(wav, frames)` reopens a cached take without analysis.
  - `render(settings)` returns notes, as the server's `/api/render`.
  - `export(settings, format)` returns `.mid` or `.als` bytes.
  - `tunings()` returns the built-in list.

### Flow

Opening a take: the studio worker decodes and hands out shares; pitch workers
run in parallel and report as each share finishes, so the UI shows
"Analyzing… N%"; the studio worker assembles; the page caches the `Frames`.
From then on every slider change is a render in the studio worker.

The engine and model are fetched once and then come from the browser cache.
Each worker prepares the model in about 65 ms.

## UI

- `api.ts` becomes a `Backend` interface with the current calls (list, open,
  upload, render, export, tunings, current take, take audio for playback), plus
  capability flags for backend-only features (Reveal in Finder, Delete take).
- `server-backend.ts`: today's code. `wasm-backend.ts`: drives the workers.
- `npm run build` builds the local studio as now. `npm run build:web` builds the
  site into `studio-ui/web-dist/`.
- Settings (sliders, tuning, anchor, export formats) persist in `localStorage`
  between visits, in both builds.

### Storage (browser build), all on the device

- Takes (recordings and opened WAVs) in IndexedDB, listed in the take picker.
- A **Delete** take control (browser build only).
- The analysis result (`Frames`) cached per take, about 150 KB per minute of
  audio, so reopening a take skips analysis.
- One line under the header: recordings stay in this browser and are never
  uploaded.

### Exports (browser build)

- **Save** downloads the ticked formats.
- **Drag-out** uses Chrome's `DownloadURL` with a `blob:` URL. Unverified: the
  first plan task checks it drags into another app. If it does not, the drag
  handles are hidden in the browser build and Save is the way out.
- Reveal in Finder is hidden.

### Recording

Unchanged AudioWorklet recorder. GitHub Pages serves HTTPS, which the mic needs.

No sample take is shipped: visitors record or drop a WAV.

## Build and deploy

- `crates/voxmpe-web` builds with `wasm-pack --target web`; SIMD
  (`+simd128`) is on through a wasm32-only `[target]` entry in
  `.cargo/config.toml`.
- `npm run build:web` bundles UI, engine and `crepe-tiny.onnx` into
  `web-dist/`. The model stays gitignored in the source repo; the build copies
  it from `models/` and fails with a pointer to `models/README.md` if missing.
- `scripts/deploy-web.sh` pushes `web-dist/` to the public repo
  `swwallowws/voxmpe-web`, served by GitHub Pages at
  `swwallowws.github.io/voxmpe-web`. That repo holds only built files, a
  LICENSE, and a NOTICE crediting CREPE (Jong Wook Kim et al., 2018) and
  torchcrepe (Max Morrison, 2020), both MIT.
- Creating `voxmpe-web` and every deploy happen only on Bengisu's explicit go.
  The voxmpe source stays private.

## Browser support

- Chrome and Edge: tested automatically.
- Safari 16.4+ and Firefox: support WASM SIMD and workers, expected to work;
  Safari checked by hand.
- On load the page checks for WebAssembly SIMD, Web Workers and IndexedDB; if
  one is missing it shows a plain message instead of failing later.

## Errors

- Engine or model download fails: a message with Retry.
- WAV fails to decode: the same message as the local studio.
- Takes longer than 10 minutes are refused with a clear message (about 2
  minutes of analysis at the measured speed).
- A pitch worker crashes: analysis fails with a message, the page stays usable,
  and the take can be reopened.

## Testing

- Rust:
  - Any split of frame indices into shares, assembled, equals native `track()`
    exactly.
  - `voxmpe-web` render and both exports, run under Node
    (`wasm-pack test --node`), equal the native `Session` byte for byte on a
    synthetic take with the tiny model.
  - The native suite stays green; the `native` feature is on by default.
- UI (vitest):
  - The `Backend` contract, shared by both implementations.
  - Worker orchestration with fake workers: share sizes, progress, a crashing
    worker.
  - The IndexedDB take store and analysis cache via `fake-indexeddb` (new dev
    dependency).
- End to end: a scripted headless Chrome run against the built site: drop a
  WAV, notes appear, a slider re-renders, Save downloads, reopening the take
  skips analysis.

## Out of scope

- The Ableton extension.
- Automated Safari or Firefox testing.
- Making the voxmpe source repo public.
- Choosing the model in the local studio (tiny for quick sketches): possible
  later, not part of this work.
