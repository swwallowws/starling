# voxmpe web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The voxmpe studio running entirely in the browser: the same Rust engine compiled to WebAssembly with CREPE tiny, pitch tracking split across Web Workers, takes and analysis kept in IndexedDB, deployable as a static site.

**Architecture:** The core's pitch tracking splits into prepare / pitch_frames / assemble so workers can share it. A new `voxmpe-web` crate wraps the engine for wasm-bindgen as a pitch worker and a studio worker. The UI's `api.ts` becomes a `Backend` interface with the existing server implementation and a new WebAssembly one, chosen at build time.

**Tech Stack:** Rust (tract-onnx 0.21, wasm-bindgen, wasm-pack), TypeScript + Vite + vitest, IndexedDB (fake-indexeddb in tests), puppeteer-core for the end-to-end check.

**Spec:** `docs/superpowers/specs/2026-09-25-voxmpe-web-design.md`

## Global Constraints

- Never use an em dash anywhere (code, comments, docs, commit messages). Avoid the "not X, Y" construction.
- The native local studio and CLI keep working unchanged, with the full CREPE model. The `native` feature is on by default.
- Browser build uses CREPE tiny (`models/crepe-tiny.onnx`, gitignored; `python scripts/export_crepe.py tiny` makes it).
- Browser analysis must equal native `track()` exactly for the same model and audio.
- Takes over 10 minutes (600 s) are refused in the browser with a clear message.
- Nothing is uploaded: takes and analysis stay in the browser (IndexedDB).
- Pitch workers: one per core, clamped to 2..8.
- Creating the public repo `swwallowws/voxmpe-web` and every deploy need Bengisu's explicit go in that moment. The voxmpe source stays private.
- Never write files to the Desktop. Temporary files go in the session scratchpad.
- Commits end with: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. A take that is all silence (no active frames): the page must open it with a warning, not hang at "Analyzing 0%". Pinned in Task 4 (`silence_opens_with_no_active_frames`) and Task 8 (`runShares` with no shares).
2. A take whose cached analysis came from a different model or is damaged: it must be re-analyzed, not rendered wrong. Pinned in Task 7 (`frames from another model are ignored`) and Task 4 (`frames_survive_encoding`).
3. Two uploads with the same name: the second must get `-2`, never overwrite. Pinned in Task 7 (`names are sanitized and never overwrite`).
4. A tuning error while rendering in the browser must read `tuning: ...` with status 400 so the renderer falls back to the last good tuning, as with the server. Pinned in Task 4 (`bad_input_reads_clearly`) and Task 9 (`engine errors become ApiError 400`).
5. Saved settings from an older version (missing or extra keys, wrong types): the studio must start with defaults for the bad keys, not crash. Pinned in Task 10 (`loadSettings keeps only known, well-typed keys`).

---

### Task 1: Drag-out check (Bengisu, before building the drag path)

The spec leaves one fact unverified: whether Chrome's `DownloadURL` drag works with a `blob:` URL. This decides `canDragOut` in Task 9.

**Files:**
- Create (scratchpad, throwaway): `<scratchpad>/drag-test.html`

- [ ] **Step 1: Write the test page**

```html
<!doctype html>
<title>drag test</title>
<p>Drag the box into a Finder window or into Live.</p>
<div id="h" draggable="true" style="padding:20px;border:2px dashed #07a;display:inline-block">drag-test.mid</div>
<script>
  // A one-note MIDI file (format 0, C4 for one beat).
  const bytes = new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,12,0,144,60,100,131,96,128,60,0,0,255,47,0]);
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  document.getElementById("h").addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("DownloadURL", `audio/midi:drag-test.mid:${url}`);
  });
</script>
```

- [ ] **Step 2: Ask Bengisu to open it in Chrome and drag the box into a Finder window (not the Desktop) or into Live**

Give her the command: `open -a "Google Chrome" <scratchpad>/drag-test.html`

Expected: either a `drag-test.mid` file appears where she dropped it, or nothing does.

- [ ] **Step 3: Record the result in the ledger**

`Task 1: Ruling: blob DownloadURL drag <works|does not work> in Chrome; Task 9 sets canDragOut = <true|false> for the web backend.`

---

### Task 2: Split pitch tracking into prepare / pitch_frames / assemble

**Files:**
- Modify: `crates/voxmpe-core/src/pitch.rs` (from_path, track_gated, frame_and_normalize)
- Modify: `crates/voxmpe-core/src/lib.rs:55-80` (track)
- Modify: `crates/voxmpe-core/Cargo.toml` (wasm32 getrandom)
- Test: `crates/voxmpe-core/tests/split.rs`

**Interfaces:**
- Produces:
  - `voxmpe_core::pitch::Prepared { pub audio16: Vec<f32>, pub n_frames: usize, pub active: Vec<u32> }` (Debug, Clone)
  - `voxmpe_core::pitch::prepare(audio: &[f32], sample_rate: u32, rms_floor: f32) -> Prepared`
  - `CrepeModel::from_bytes(bytes: &[u8]) -> anyhow::Result<CrepeModel>`
  - `CrepeModel::pitch_frames(&self, audio16: &[f32], indices: &[u32]) -> anyhow::Result<Vec<(f32, f32)>>`
  - `voxmpe_core::pitch::assemble(n_frames: usize, active: &[u32], results: &[(f32, f32)]) -> anyhow::Result<Vec<RawPitch>>`
  - `voxmpe_core::frames_from_raw(raw: &[pitch::RawPitch], audio: &[f32], sample_rate: u32, cfg: &AnalysisConfig) -> Frames`

- [ ] **Step 1: Write the failing tests**

`crates/voxmpe-core/tests/split.rs`:

```rust
//! Browser pitch tracking runs in shares across workers. Any split, assembled,
//! must equal the native `track()` exactly.

use voxmpe_core::pitch::{self, CrepeModel};
use voxmpe_core::{frames_from_raw, track, AnalysisConfig};

const SR: u32 = 44_100;
const TINY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-tiny.onnx");

fn tiny() -> Option<CrepeModel> {
    if !std::path::Path::new(TINY).exists() {
        eprintln!("skipping: {TINY} missing (see models/README.md)");
        return None;
    }
    Some(CrepeModel::from_path(TINY).unwrap())
}

/// A4, a silent gap, then C5: the gap leaves frames out of the active list.
fn phrase() -> Vec<f32> {
    let n = (SR as f32 * 1.6) as usize;
    let mut phase = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / SR as f32;
            if (0.6..0.9).contains(&t) {
                return 0.0;
            }
            let hz = if t < 0.6 { 440.0 } else { 523.25 };
            phase += 2.0 * std::f32::consts::PI * hz / SR as f32;
            0.3 * (phase.sin() + 0.5 * (2.0 * phase).sin())
        })
        .collect()
}

#[test]
fn any_split_equals_native_track() {
    let Some(model) = tiny() else { return };
    let cfg = AnalysisConfig::default();
    let audio = phrase();
    let native = track(&audio, SR, &model, &cfg).unwrap();
    let prep = pitch::prepare(&audio, SR, cfg.segmentation.rms_floor);
    assert_eq!(prep.n_frames, native.frames.len());
    assert!(prep.active.len() < prep.n_frames, "the gap leaves frames out");
    for shares in [1, 3, 7] {
        let size = prep.active.len().div_ceil(shares);
        let mut results = Vec::new();
        for idx in prep.active.chunks(size) {
            results.extend(model.pitch_frames(&prep.audio16, idx).unwrap());
        }
        let raw = pitch::assemble(prep.n_frames, &prep.active, &results).unwrap();
        let split = frames_from_raw(&raw, &audio, SR, &cfg);
        assert_eq!(format!("{:?}", split.frames), format!("{:?}", native.frames), "{shares} shares");
        assert_eq!(split.hop_s, native.hop_s);
    }
}

#[test]
fn from_bytes_matches_from_path() {
    let Some(model) = tiny() else { return };
    let bytes = CrepeModel::from_bytes(&std::fs::read(TINY).unwrap()).unwrap();
    let prep = pitch::prepare(&phrase(), SR, 0.0);
    let idx = &prep.active[..40];
    assert_eq!(
        format!("{:?}", model.pitch_frames(&prep.audio16, idx).unwrap()),
        format!("{:?}", bytes.pitch_frames(&prep.audio16, idx).unwrap())
    );
}

#[test]
fn a_frame_past_the_end_is_an_error() {
    let Some(model) = tiny() else { return };
    let prep = pitch::prepare(&phrase(), SR, 0.0);
    let err = model.pitch_frames(&prep.audio16, &[prep.n_frames as u32]).unwrap_err();
    assert!(format!("{err}").contains("out of range"), "{err}");
}

#[test]
fn assemble_puts_results_in_frame_order_and_checks_lengths() {
    let raw = pitch::assemble(4, &[1, 3], &[(100.0, 0.9), (200.0, 0.8)]).unwrap();
    let got: Vec<_> = raw.iter().map(|r| (r.f0_hz, r.confidence)).collect();
    assert_eq!(got, [(0.0, 0.0), (100.0, 0.9), (0.0, 0.0), (200.0, 0.8)]);
    assert!(pitch::assemble(4, &[1, 3], &[(1.0, 1.0)]).is_err());
    assert!(pitch::assemble(2, &[5], &[(1.0, 1.0)]).is_err());
}

#[test]
fn silence_prepares_no_active_frames() {
    let prep = pitch::prepare(&vec![0.0; SR as usize], SR, AnalysisConfig::default().segmentation.rms_floor);
    assert!(prep.n_frames > 0);
    assert!(prep.active.is_empty());
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p voxmpe-core --release --test split 2>&1 | tail -5`
Expected: compile errors: `cannot find function 'prepare' in module 'pitch'`, `no function or associated item named 'from_bytes'`, `unresolved import voxmpe_core::frames_from_raw`.

- [ ] **Step 3: Implement in `pitch.rs`**

Add `bail` to the anyhow import: `use anyhow::{bail, Context, Result};`

Replace `from_path` with:

```rust
    pub fn from_path(path: &str) -> Result<Self> {
        let model = tract_onnx::onnx()
            .model_for_path(path)
            .with_context(|| format!("loading CREPE ONNX from {path}"))?;
        Self::from_model(model)
    }

    /// Load from ONNX bytes (the browser fetches the model instead of reading a file).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let model = tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(bytes))
            .context("loading CREPE ONNX from bytes")?;
        Self::from_model(model)
    }

    fn from_model(model: InferenceModel) -> Result<Self> {
        let plan = model
            .with_input_fact(0, f32::fact([BATCH, WINDOW]).into())?
            .into_optimized()?
            .into_runnable()?;
        Ok(Self { plan })
    }
```

Replace the body of `track_gated` (keep its doc comment and signature) with:

```rust
        let prep = prepare(audio, sample_rate, rms_floor);
        if prep.n_frames == 0 {
            return Ok(vec![]);
        }
        // Frames are independent, so shares run in parallel: one contiguous
        // share of the active frames per core, each a whole number of batches.
        let threads = std::thread::available_parallelism().map_or(1, |p| p.get());
        let per_thread = prep.active.len().div_ceil(BATCH).div_ceil(threads).max(1) * BATCH;
        let results = std::thread::scope(|s| {
            let jobs: Vec<_> = prep
                .active
                .chunks(per_thread)
                .map(|idx| {
                    let audio16 = &prep.audio16;
                    s.spawn(move || self.pitch_frames(audio16, idx))
                })
                .collect();
            jobs.into_iter()
                .map(|j| j.join().expect("pitch worker panicked"))
                .collect::<Result<Vec<_>>>()
        })?;
        assemble(prep.n_frames, &prep.active, &results.concat())
```

Add to `impl CrepeModel` after `track_gated`:

```rust
    /// The slow step: `(f0_hz, confidence)` for each frame in `indices`, from
    /// the 16 kHz audio `prepare` returned. Workers each run a share.
    pub fn pitch_frames(&self, audio16: &[f32], indices: &[u32]) -> Result<Vec<(f32, f32)>> {
        let padded = pad(audio16);
        let n = frame_count(padded.len());
        if let Some(&bad) = indices.iter().find(|&&i| i as usize >= n) {
            bail!("frame {bad} out of range ({n} frames)");
        }
        let frames: Vec<[f32; WINDOW]> = indices
            .iter()
            .map(|&i| normalized_frame(&padded, i as usize))
            .collect();
        let mut out = vec![(0.0f32, 0.0f32); frames.len()];
        self.run_batches(&frames, &mut out)?;
        Ok(out)
    }
```

Add as free items after the `RawPitch` struct:

```rust
/// The cheap first step of pitch tracking: the audio at 16 kHz, how many
/// frames it has, and which frames are loud enough to analyze.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub audio16: Vec<f32>,
    pub n_frames: usize,
    /// Frames whose RMS reaches the floor, ascending.
    pub active: Vec<u32>,
}

/// Resample and list the frames worth analyzing. Frames below `rms_floor`
/// come back from [`assemble`] as f0 0, confidence 0.
pub fn prepare(audio: &[f32], sample_rate: u32, rms_floor: f32) -> Prepared {
    let audio16 = resample(audio, sample_rate, CREPE_SR);
    let padded = pad(&audio16);
    let n_frames = frame_count(padded.len());
    let active = (0..n_frames)
        .filter(|&i| frame_rms(&padded, i) >= rms_floor)
        .map(|i| i as u32)
        .collect();
    Prepared { audio16, n_frames, active }
}

/// Put `results` (one per `active` frame, same order) back in frame order;
/// frames not in `active` are unvoiced.
pub fn assemble(n_frames: usize, active: &[u32], results: &[(f32, f32)]) -> Result<Vec<RawPitch>> {
    if active.len() != results.len() {
        bail!("{} results for {} frames", results.len(), active.len());
    }
    let mut all = vec![(0.0f32, 0.0f32); n_frames];
    for (&i, &r) in active.iter().zip(results) {
        let slot = all
            .get_mut(i as usize)
            .with_context(|| format!("frame {i} out of range ({n_frames} frames)"))?;
        *slot = r;
    }
    let hop_s = HOP as f32 / CREPE_SR as f32;
    Ok(all
        .into_iter()
        .enumerate()
        .map(|(i, (f0_hz, confidence))| RawPitch {
            time: i as f32 * hop_s,
            f0_hz,
            confidence,
        })
        .collect())
}
```

Replace `frame_and_normalize` (and its doc comment) with:

```rust
/// Center-pad 16 kHz audio with zeros (matching torch F.pad), so frame `i`
/// starts at `i * HOP`.
fn pad(audio16: &[f32]) -> Vec<f32> {
    let pad = WINDOW / 2;
    let mut padded = vec![0.0f32; audio16.len() + 2 * pad];
    padded[pad..pad + audio16.len()].copy_from_slice(audio16);
    padded
}

/// Frames in a padded buffer (centered, 10 ms hop).
fn frame_count(padded_len: usize) -> usize {
    if padded_len < WINDOW {
        0
    } else {
        (padded_len - WINDOW) / HOP + 1
    }
}

/// Frame `i`'s RMS before normalization.
fn frame_rms(padded: &[f32], i: usize) -> f32 {
    let frame = &padded[i * HOP..i * HOP + WINDOW];
    (frame.iter().map(|s| s * s).sum::<f32>() / WINDOW as f32).sqrt()
}

/// Frame `i`, normalized to zero mean and unit standard deviation.
fn normalized_frame(padded: &[f32], i: usize) -> [f32; WINDOW] {
    let mut frame = [0.0f32; WINDOW];
    frame.copy_from_slice(&padded[i * HOP..i * HOP + WINDOW]);
    let mean = frame.iter().sum::<f32>() / WINDOW as f32;
    let mut var = 0.0f32;
    for v in &mut frame {
        *v -= mean;
        var += *v * *v;
    }
    let std = (var / WINDOW as f32).sqrt().max(1e-10);
    for v in &mut frame {
        *v /= std;
    }
    frame
}
```

- [ ] **Step 4: Implement in `lib.rs`**

Replace the body of `track` after `let raw = ...;` so it reads:

```rust
pub fn track(
    audio: &[f32],
    sample_rate: u32,
    model: &CrepeModel,
    cfg: &AnalysisConfig,
) -> Result<Frames> {
    let raw = model.track_gated(audio, sample_rate, cfg.segmentation.rms_floor)?;
    Ok(frames_from_raw(&raw, audio, sample_rate, cfg))
}

/// The rest of [`track`] once raw pitch is known (natively, or assembled from
/// browser pitch workers): per-frame loudness and centroid, and the voicing gate.
pub fn frames_from_raw(
    raw: &[pitch::RawPitch],
    audio: &[f32],
    sample_rate: u32,
    cfg: &AnalysisConfig,
) -> Frames {
    let hop_s = pitch::HOP as f32 / pitch::CREPE_SR as f32;
    let feats = features::extract(audio, sample_rate, raw.len());
    let mut frames: Vec<Frame> = raw
        .iter()
        .zip(feats.iter())
        .map(|(p, ft)| Frame {
            time: p.time,
            f0_hz: p.f0_hz,
            confidence: p.confidence,
            rms: ft.rms,
            centroid_hz: ft.centroid_hz,
            voiced: false,
        })
        .collect();
    apply_voicing(&mut frames, &cfg.segmentation);
    Frames { frames, hop_s }
}
```

- [ ] **Step 5: Add the wasm32 getrandom feature to `crates/voxmpe-core/Cargo.toml`** (tract pulls in `getrandom`, which needs its `js` feature in the browser)

```toml

# tract pulls in getrandom, which needs its JS backend in the browser.
[target.'cfg(target_arch = "wasm32")'.dependencies]
getrandom = { version = "0.2", features = ["js"] }
```

- [ ] **Step 6: Run the new tests and the whole core suite**

Run: `cargo test -p voxmpe-core --release 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: every line `test result: ok`, including `split` with 5 passed. If `any_split_equals_native_track` fails on tiny float differences between batch positions, stop and rule in the ledger (the spec requires exact equality; the fix is to make shares whole batches, not to loosen the test).

- [ ] **Step 7: Check the core compiles for the browser**

Run: `cargo check -p voxmpe-core --target wasm32-unknown-unknown 2>&1 | tail -2`
Expected: `Finished`.

- [ ] **Step 8: Commit**

```bash
git add crates/voxmpe-core
git commit -m "Core: split pitch tracking into prepare, pitch_frames, assemble

Browser workers each run a share of the frames; native tracking chains the
same steps with its threads. Any split equals native track() exactly.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `native` feature and `Session::from_frames`

**Files:**
- Modify: `crates/voxmpe/Cargo.toml`
- Modify: `crates/voxmpe/src/lib.rs`
- Modify: `crates/voxmpe/src/session.rs` (`load`)
- Test: `crates/voxmpe/tests/session.rs` (append)

**Interfaces:**
- Consumes: `voxmpe_core::Frames` (Clone).
- Produces:
  - `Session::from_frames(name: &str, wav: Vec<u8>, frames: Frames) -> anyhow::Result<Session>`
  - `Session::frames(&self) -> &Frames`
  - Cargo feature `native` (default) gating modules `cli`, `model`, `server` and the binary.

- [ ] **Step 1: Write the failing test** (append to `crates/voxmpe/tests/session.rs`)

```rust
/// The browser rebuilds a session from frames analyzed elsewhere: it must be
/// the same take as one loaded natively.
#[test]
fn a_session_from_frames_matches_a_loaded_one() {
    let Some(m) = model() else { return };
    let w = wav(&step(0.3));
    let loaded = Session::load("step", w.clone(), &m).unwrap();
    let rebuilt = Session::from_frames("step", w, loaded.frames().clone()).unwrap();
    let s = Settings::default();
    assert_eq!(
        serde_json::to_string(&loaded.info()).unwrap(),
        serde_json::to_string(&rebuilt.info()).unwrap()
    );
    assert_eq!(loaded.export_mid(&s).unwrap(), rebuilt.export_mid(&s).unwrap());
    assert_eq!(loaded.export_als(&s).unwrap(), rebuilt.export_als(&s).unwrap());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p voxmpe --release --test session a_session_from_frames 2>&1 | grep -E "^error" | head -3`
Expected: `error[E0599]: no function or associated item named 'from_frames'`.

- [ ] **Step 3: Implement `from_frames` in `session.rs`**

Replace `Session::load` with:

```rust
    pub fn load(name: &str, wav: Vec<u8>, model: &CrepeModel) -> Result<Session> {
        let (audio, sr) = decode_wav(&wav)?;
        let frames = track(&audio, sr, model, &AnalysisConfig::default())?;
        Ok(Session::assemble(name, wav, &audio, sr, frames))
    }

    /// A take whose slow analysis ran elsewhere (the browser's pitch workers,
    /// or a cache). `frames` must come from this same WAV.
    pub fn from_frames(name: &str, wav: Vec<u8>, frames: Frames) -> Result<Session> {
        let (audio, sr) = decode_wav(&wav)?;
        Ok(Session::assemble(name, wav, &audio, sr, frames))
    }

    /// The slow stage's output, to cache.
    pub fn frames(&self) -> &Frames {
        &self.frames
    }

    fn assemble(name: &str, wav: Vec<u8>, audio: &[f32], sr: u32, frames: Frames) -> Session {
        let warning = (peak(audio) < QUIET_PEAK).then(|| {
            "Very quiet take: check that the right mic is selected and its level is up.".to_string()
        });
        Session {
            name: name.to_string(),
            wav,
            duration_s: audio.len() as f32 / sr as f32,
            frames,
            warning,
        }
    }
```

- [ ] **Step 4: Run the test**

Run: `cargo test -p voxmpe --release --test session 2>&1 | grep -E "test result|FAILED"`
Expected: `test result: ok.` with 10 passed.

- [ ] **Step 5: Gate the native-only parts**

In `crates/voxmpe/Cargo.toml`, make `clap`, `tiny_http` and `include_dir` optional and add the feature:

```toml
[[bin]]
name = "voxmpe"
path = "src/main.rs"
required-features = ["native"]

[features]
default = ["native"]
# The CLI, the studio server and reading the model from disk. Off for the browser build.
native = ["dep:clap", "dep:tiny_http", "dep:include_dir"]

[dependencies]
voxmpe-core = { path = "../voxmpe-core" }
hound = "3.5"
anyhow = "1"
clap = { version = "4", features = ["derive"], optional = true }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tiny_http = { version = "0.12", optional = true }
include_dir = { version = "0.7", optional = true }
expressive-liveset = { git = "ssh://git@github.com/swwallowws/expressive-liveset.git", rev = "28d48a713b26e61cd1e08274a673ae741d32f435" }
```

In `crates/voxmpe/src/lib.rs`, gate three modules:

```rust
#[cfg(feature = "native")]
pub mod cli;
#[cfg(feature = "native")]
pub mod model;
#[cfg(feature = "native")]
pub mod server;
```

(keep the other `pub mod` lines as they are).

- [ ] **Step 6: Verify both builds**

Run: `cargo check -p voxmpe --lib --no-default-features --target wasm32-unknown-unknown 2>&1 | tail -1 && cargo test --release 2>&1 | grep -E "test result|FAILED" | grep -v "ok\." ; echo done`
Expected: `Finished ...` then only `done` (no failing lines).

- [ ] **Step 7: Commit**

```bash
git add crates/voxmpe
git commit -m "voxmpe: native feature and Session::from_frames

The CLI, server and model file loading sit behind the default native feature,
so settings, tunings, retune, shaping and both exporters compile for the
browser. from_frames opens a take analyzed elsewhere.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The `voxmpe-web` crate

**Files:**
- Create: `crates/voxmpe-web/Cargo.toml`, `crates/voxmpe-web/src/lib.rs`, `crates/voxmpe-web/src/engine.rs`
- Test: `crates/voxmpe-web/tests/engine.rs`
- Modify: `Cargo.toml` (workspace members), `.cargo/config.toml` (wasm SIMD)

**Interfaces:**
- Consumes: Task 2 (`prepare`, `pitch_frames`, `assemble`, `frames_from_raw`, `from_bytes`), Task 3 (`Session::from_frames`, `Session::frames`).
- Produces (Rust, `voxmpe_web::`): `MAX_SECONDS: f32 = 600.0`, `Pitch::new(&[u8])`, `Pitch::run(&self, &[f32], &[u32]) -> Result<Vec<f32>>`, `Engine::{new, load, prepared, finish, restore, frames, render, export}`, `tunings_json() -> String`, `encode_frames(&Frames) -> Vec<f32>`, `decode_frames(&[f32]) -> Result<Frames>`.
- Produces (JavaScript, from wasm-bindgen, used by Task 8's workers):
  - `class PitchWorker { constructor(model: Uint8Array); run(audio16: Float32Array, indices: Uint32Array): Float32Array }`
  - `class Studio { constructor(); load(name: string, wav: Uint8Array): void; audio16(): Float32Array; active(): Uint32Array; finish(results: Float32Array): string; restore(name: string, wav: Uint8Array, frames: Float32Array): string; frames(): Float32Array; render(settingsJson: string): string; export(settingsJson: string, format: string): Uint8Array }`
  - `function tunings(): string`
  - Errors throw a JS `Error` whose message is the Rust error chain.

- [ ] **Step 1: Scaffold the crate**

`crates/voxmpe-web/Cargo.toml`:

```toml
[package]
name = "voxmpe-web"
version = "0.1.0"
edition = "2021"
publish = false
description = "voxmpe in the browser: the engine for pitch and studio Web Workers."

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
voxmpe = { path = "../voxmpe", default-features = false }
voxmpe-core = { path = "../voxmpe-core" }
anyhow = "1"
serde_json = "1"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"

[dev-dependencies]
hound = "3.5"
```

Root `Cargo.toml`: `members = ["crates/voxmpe-core", "crates/voxmpe", "crates/voxmpe-web"]`.

Append to `.cargo/config.toml`:

```toml

# WebAssembly SIMD: about 1.5x faster CREPE in the browser (measured 2026-09-25).
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
```

`crates/voxmpe-web/src/lib.rs` (bindings added in Step 5):

```rust
//! voxmpe in the browser. [`engine`] is plain Rust, tested natively; on wasm32
//! the `bindings` module exposes it to the pitch and studio Web Workers.

mod engine;

pub use engine::*;
```

`crates/voxmpe-web/src/engine.rs`: empty for now.

- [ ] **Step 2: Write the failing tests** (`crates/voxmpe-web/tests/engine.rs`)

```rust
//! The browser engine must give exactly what the native studio gives.

use std::io::Cursor;

use voxmpe::session::Session;
use voxmpe::settings::Settings;
use voxmpe_core::{types::Frame, CrepeModel, Frames};
use voxmpe_web::{decode_frames, encode_frames, Engine, Pitch, MAX_SECONDS};

const TINY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-tiny.onnx");

fn tiny() -> Option<Vec<u8>> {
    std::fs::read(TINY)
        .map_err(|_| eprintln!("skipping: {TINY} missing (see models/README.md)"))
        .ok()
}

fn wav(samples: &[f32], sr: u32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sr,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for &s in samples {
            w.write_sample((s * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }
    cur.into_inner()
}

/// A4, a short silence, then C5 with vibrato.
fn phrase() -> Vec<u8> {
    let sr = 44_100;
    let mut phase = 0.0f32;
    let samples: Vec<f32> = (0..(sr as f32 * 1.4) as usize)
        .map(|i| {
            let t = i as f32 / sr as f32;
            if (0.5..0.7).contains(&t) {
                return 0.0;
            }
            let hz = if t < 0.5 { 440.0 } else { 523.25 * (1.0 + 0.01 * (t * 35.0).sin()) };
            phase += 2.0 * std::f32::consts::PI * hz / sr as f32;
            0.3 * (phase.sin() + 0.5 * (2.0 * phase).sin())
        })
        .collect();
    wav(&samples, sr)
}

/// Analyze the loaded take with `shares` pitch workers, as the page does.
fn analyze(engine: &mut Engine, pitch: &Pitch, shares: usize) -> String {
    let prep = engine.prepared().unwrap().clone();
    let size = prep.active.len().div_ceil(shares).max(1);
    let mut results = Vec::new();
    for idx in prep.active.chunks(size) {
        results.extend(pitch.run(&prep.audio16, idx).unwrap());
    }
    engine.finish(&results).unwrap()
}

fn tuned() -> Settings {
    let scl = voxmpe::tunings::presets()
        .into_iter()
        .find(|p| p.id == "31-edo")
        .unwrap()
        .scl;
    Settings {
        tuning_name: Some("31-edo".into()),
        tuning_scl: Some(scl),
        smoothing: 0.5,
        ..Settings::default()
    }
}

#[test]
fn the_browser_engine_matches_the_native_session() {
    let Some(model) = tiny() else { return };
    let native = Session::load("phrase", phrase(), &CrepeModel::from_bytes(&model).unwrap()).unwrap();
    let pitch = Pitch::new(&model).unwrap();
    let mut engine = Engine::new();
    engine.load("phrase", phrase()).unwrap();
    let info = analyze(&mut engine, &pitch, 3);
    assert_eq!(info, serde_json::to_string(&native.info()).unwrap());
    let s = tuned();
    let json = serde_json::to_string(&s).unwrap();
    assert_eq!(
        engine.render(&json).unwrap(),
        serde_json::to_string(&native.render(&s).unwrap()).unwrap()
    );
    assert_eq!(engine.export(&json, "mid").unwrap(), native.export_mid(&s).unwrap());
    assert_eq!(engine.export(&json, "als").unwrap(), native.export_als(&s).unwrap());
}

#[test]
fn a_restored_take_needs_no_analysis() {
    let Some(model) = tiny() else { return };
    let pitch = Pitch::new(&model).unwrap();
    let mut first = Engine::new();
    first.load("phrase", phrase()).unwrap();
    let info = analyze(&mut first, &pitch, 2);
    let cached = first.frames().unwrap();
    let mut again = Engine::new();
    assert_eq!(again.restore("phrase", phrase(), &cached).unwrap(), info);
    assert_eq!(again.render("{}").unwrap(), first.render("{}").unwrap());
}

#[test]
fn silence_opens_with_no_active_frames() {
    let mut engine = Engine::new();
    engine.load("quiet", wav(&vec![0.0; 44_100], 44_100)).unwrap();
    assert!(engine.prepared().unwrap().active.is_empty());
    let info: serde_json::Value = serde_json::from_str(&engine.finish(&[]).unwrap()).unwrap();
    assert!(info["warning"].as_str().unwrap().contains("quiet"));
    assert!(engine.render("{}").unwrap().contains("\"notes\":[]"));
}

#[test]
fn frames_survive_encoding() {
    let f = Frames {
        hop_s: 0.01,
        frames: vec![
            Frame { time: 0.0, f0_hz: 440.0, confidence: 0.9, rms: 0.2, centroid_hz: 900.0, voiced: true },
            Frame { time: 0.01, f0_hz: 0.0, confidence: 0.0, rms: 0.0, centroid_hz: 0.0, voiced: false },
        ],
    };
    let back = decode_frames(&encode_frames(&f)).unwrap();
    assert_eq!(format!("{:?}", back.frames), format!("{:?}", f.frames));
    assert_eq!(back.hop_s, f.hop_s);
    assert!(decode_frames(&[]).is_err());
    assert!(format!("{}", decode_frames(&[0.01, 1.0]).unwrap_err()).contains("damaged"));
}

#[test]
fn takes_over_ten_minutes_are_refused() {
    let long = vec![0.0f32; (8_000.0 * (MAX_SECONDS + 1.0)) as usize];
    let err = Engine::new().load("long", wav(&long, 8_000)).unwrap_err();
    assert!(format!("{err}").contains("10 minutes"), "{err}");
}

#[test]
fn bad_input_reads_clearly() {
    let mut engine = Engine::new();
    assert!(format!("{}", engine.render("{}").unwrap_err()).contains("no take is open"));
    assert!(format!("{}", engine.finish(&[]).unwrap_err()).contains("no take is being analyzed"));
    engine.load("quiet", wav(&vec![0.0; 8_000], 8_000)).unwrap();
    engine.finish(&[]).unwrap();
    assert!(format!("{}", engine.export("{}", "wav").unwrap_err()).contains("unknown export format"));
    let bad = r#"{"tuning_scl": "not a scale"}"#;
    assert!(format!("{}", engine.render(bad).unwrap_err()).starts_with("tuning"));
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cargo test -p voxmpe-web --release 2>&1 | grep -E "^error" | head -3`
Expected: `error[E0432]: unresolved imports voxmpe_web::decode_frames ...`.

- [ ] **Step 4: Implement `engine.rs`**

```rust
//! The browser engine as plain Rust, tested natively. `lib.rs` exposes it to
//! JavaScript on wasm32.

use anyhow::{anyhow, bail, Context, Result};
use voxmpe::session::Session;
use voxmpe::settings::Settings;
use voxmpe_core::pitch::{self, CrepeModel, Prepared};
use voxmpe_core::types::Frame;
use voxmpe_core::{frames_from_raw, AnalysisConfig, Frames};

/// Longest take the browser analyzes: about 2 minutes of work at the measured speed.
pub const MAX_SECONDS: f32 = 600.0;

/// One pitch worker: CREPE tiny, loaded once.
pub struct Pitch {
    model: CrepeModel,
}

impl Pitch {
    pub fn new(model: &[u8]) -> Result<Pitch> {
        Ok(Pitch { model: CrepeModel::from_bytes(model)? })
    }

    /// `f0_hz, confidence` for each listed frame, flattened.
    pub fn run(&self, audio16: &[f32], indices: &[u32]) -> Result<Vec<f32>> {
        Ok(self
            .model
            .pitch_frames(audio16, indices)?
            .into_iter()
            .flat_map(|(f0, conf)| [f0, conf])
            .collect())
    }
}

struct Pending {
    name: String,
    wav: Vec<u8>,
    audio: Vec<f32>,
    sample_rate: u32,
    prep: Prepared,
}

/// The studio worker: at most one take being analyzed and one take open.
#[derive(Default)]
pub struct Engine {
    pending: Option<Pending>,
    session: Option<Session>,
}

impl Engine {
    pub fn new() -> Engine {
        Engine::default()
    }

    /// Decode `wav` and list the frames the pitch workers must analyze.
    pub fn load(&mut self, name: &str, wav: Vec<u8>) -> Result<&Prepared> {
        let (audio, sample_rate) = voxmpe::audio::decode_wav(&wav)?;
        let seconds = audio.len() as f32 / sample_rate as f32;
        if seconds > MAX_SECONDS {
            bail!(
                "this take is {:.0} minutes long; the browser studio takes up to 10 minutes",
                seconds / 60.0
            );
        }
        let floor = AnalysisConfig::default().segmentation.rms_floor;
        let prep = pitch::prepare(&audio, sample_rate, floor);
        self.pending = Some(Pending { name: name.to_string(), wav, audio, sample_rate, prep });
        Ok(&self.pending.as_ref().expect("just set").prep)
    }

    /// The take being analyzed, if any.
    pub fn prepared(&self) -> Option<&Prepared> {
        self.pending.as_ref().map(|p| &p.prep)
    }

    /// Open the loaded take from the workers' results (two floats per active
    /// frame, in `active` order). Returns the take info as JSON.
    pub fn finish(&mut self, results: &[f32]) -> Result<String> {
        let p = self.pending.take().context("no take is being analyzed")?;
        if results.len() % 2 != 0 {
            bail!("pitch results must come in pairs");
        }
        let pairs: Vec<(f32, f32)> = results.chunks_exact(2).map(|c| (c[0], c[1])).collect();
        let raw = pitch::assemble(p.prep.n_frames, &p.prep.active, &pairs)?;
        let frames = frames_from_raw(&raw, &p.audio, p.sample_rate, &AnalysisConfig::default());
        self.open(Session::from_frames(&p.name, p.wav, frames)?)
    }

    /// Reopen a take from its cached analysis. Returns the take info as JSON.
    pub fn restore(&mut self, name: &str, wav: Vec<u8>, frames: &[f32]) -> Result<String> {
        self.open(Session::from_frames(name, wav, decode_frames(frames)?)?)
    }

    fn open(&mut self, s: Session) -> Result<String> {
        let info = serde_json::to_string(&s.info())?;
        self.session = Some(s);
        Ok(info)
    }

    /// The open take's analysis, to cache.
    pub fn frames(&self) -> Result<Vec<f32>> {
        Ok(encode_frames(self.session()?.frames()))
    }

    /// Notes for `settings_json`, as the server's `/api/render` returns them.
    pub fn render(&self, settings_json: &str) -> Result<String> {
        let s = settings(settings_json)?;
        Ok(serde_json::to_string(&self.session()?.render(&s)?)?)
    }

    /// `.mid` (`format` "mid") or `.als` ("als") bytes.
    pub fn export(&self, settings_json: &str, format: &str) -> Result<Vec<u8>> {
        let s = settings(settings_json)?;
        let session = self.session()?;
        match format {
            "mid" => session.export_mid(&s),
            "als" => session.export_als(&s),
            other => bail!("unknown export format {other:?}"),
        }
    }

    fn session(&self) -> Result<&Session> {
        self.session.as_ref().context("no take is open")
    }
}

/// Settings from JSON, the tuning checked first so its error reads
/// "tuning: ..." like the server's (the page falls back on that prefix).
fn settings(json: &str) -> Result<Settings> {
    let s: Settings = serde_json::from_str(json).context("reading settings")?;
    s.tuning().map_err(|e| anyhow!("tuning: {e}"))?;
    Ok(s)
}

/// The built-in tunings as JSON, as the server's `/api/tunings`.
pub fn tunings_json() -> String {
    serde_json::to_string(&voxmpe::tunings::presets()).expect("tunings serialize")
}

/// Floats per frame in the cache encoding.
const FIELDS: usize = 6;

/// Frames as floats for the cache: the hop, then six values per frame.
pub fn encode_frames(f: &Frames) -> Vec<f32> {
    let mut v = Vec::with_capacity(1 + f.frames.len() * FIELDS);
    v.push(f.hop_s);
    for fr in &f.frames {
        let voiced = if fr.voiced { 1.0 } else { 0.0 };
        v.extend([fr.time, fr.f0_hz, fr.confidence, fr.rms, fr.centroid_hz, voiced]);
    }
    v
}

pub fn decode_frames(v: &[f32]) -> Result<Frames> {
    let (&hop_s, rest) = v.split_first().context("empty analysis cache")?;
    if rest.len() % FIELDS != 0 {
        bail!("damaged analysis cache");
    }
    Ok(Frames {
        hop_s,
        frames: rest
            .chunks_exact(FIELDS)
            .map(|c| Frame {
                time: c[0],
                f0_hz: c[1],
                confidence: c[2],
                rms: c[3],
                centroid_hz: c[4],
                voiced: c[5] != 0.0,
            })
            .collect(),
    })
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test -p voxmpe-web --release 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: `test result: ok. 6 passed`.

- [ ] **Step 6: Add the JavaScript bindings** (append to `crates/voxmpe-web/src/lib.rs`)

```rust

#[cfg(target_arch = "wasm32")]
mod bindings {
    use wasm_bindgen::prelude::*;

    use crate::engine::{tunings_json, Engine, Pitch};

    fn js(e: anyhow::Error) -> JsError {
        JsError::new(&format!("{e:#}"))
    }

    /// CREPE tiny for one pitch worker.
    #[wasm_bindgen]
    pub struct PitchWorker(Pitch);

    #[wasm_bindgen]
    impl PitchWorker {
        #[wasm_bindgen(constructor)]
        pub fn new(model: &[u8]) -> Result<PitchWorker, JsError> {
            Pitch::new(model).map(PitchWorker).map_err(js)
        }

        pub fn run(&self, audio16: &[f32], indices: &[u32]) -> Result<Vec<f32>, JsError> {
            self.0.run(audio16, indices).map_err(js)
        }
    }

    /// The open take, for the studio worker.
    #[wasm_bindgen]
    pub struct Studio(Engine);

    #[wasm_bindgen]
    impl Studio {
        #[allow(clippy::new_without_default)]
        #[wasm_bindgen(constructor)]
        pub fn new() -> Studio {
            Studio(Engine::new())
        }

        /// Decode and prepare a take; then read `audio16()` and `active()`.
        pub fn load(&mut self, name: &str, wav: Vec<u8>) -> Result<(), JsError> {
            self.0.load(name, wav).map(|_| ()).map_err(js)
        }

        pub fn audio16(&self) -> Result<Vec<f32>, JsError> {
            self.0.prepared().map(|p| p.audio16.clone()).ok_or_else(|| JsError::new("no take is being analyzed"))
        }

        pub fn active(&self) -> Result<Vec<u32>, JsError> {
            self.0.prepared().map(|p| p.active.clone()).ok_or_else(|| JsError::new("no take is being analyzed"))
        }

        pub fn finish(&mut self, results: &[f32]) -> Result<String, JsError> {
            self.0.finish(results).map_err(js)
        }

        pub fn restore(&mut self, name: &str, wav: Vec<u8>, frames: &[f32]) -> Result<String, JsError> {
            self.0.restore(name, wav, frames).map_err(js)
        }

        pub fn frames(&self) -> Result<Vec<f32>, JsError> {
            self.0.frames().map_err(js)
        }

        pub fn render(&self, settings: &str) -> Result<String, JsError> {
            self.0.render(settings).map_err(js)
        }

        pub fn export(&self, settings: &str, format: &str) -> Result<Vec<u8>, JsError> {
            self.0.export(settings, format).map_err(js)
        }
    }

    #[wasm_bindgen]
    pub fn tunings() -> String {
        tunings_json()
    }
}
```

- [ ] **Step 7: Build it for the browser and lint**

Run: `wasm-pack build crates/voxmpe-web --release --target web --out-dir /tmp/voxmpe-web-check 2>&1 | grep -E "Done|error" ; cargo clippy --workspace --all-targets -q -- -D warnings 2>&1 | head -5`
Use the session scratchpad instead of `/tmp` for `--out-dir`.
Expected: `Done in ...`, then no clippy output.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock .cargo/config.toml crates/voxmpe-web
git commit -m "voxmpe-web: the engine for the browser's pitch and studio workers

Engine and Pitch are plain Rust, tested against the native Session byte for
byte with CREPE tiny; wasm-bindgen exposes them as PitchWorker and Studio.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Web build pipeline and a WebAssembly smoke test

**Files:**
- Modify: `studio-ui/package.json`, `studio-ui/vite.config.ts`, `studio-ui/tsconfig.json`, `.gitignore`, `models/README.md`
- Create: `studio-ui/scripts/copy-model.mjs`, `studio-ui/scripts/wasm-smoke.mjs`, `studio-ui/scripts/wav.mjs`, `studio-ui/tsconfig.web.json`

**Interfaces:**
- Consumes: Task 4's JavaScript API.
- Produces: `npm run build:wasm` (package in `studio-ui/src/wasm-pkg/`), `npm run build:web` (site in `studio-ui/web-dist/`), `npm run smoke:wasm`, `scripts/wav.mjs` exporting `wav16(samples: Float32Array, sr: number): Uint8Array` and `phrase(sr: number): Float32Array` (reused by Task 11).

- [ ] **Step 1: Ignore build outputs** (append to `.gitignore`)

```
# Browser build: wasm package, copied model, built site.
/studio-ui/src/wasm-pkg
/studio-ui/public-web
/studio-ui/web-dist
```

- [ ] **Step 2: Scripts in `studio-ui/package.json`**

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "check": "tsc --noEmit",
    "test": "vitest run",
    "build:wasm": "wasm-pack build ../crates/voxmpe-web --release --target web --out-dir ../../studio-ui/src/wasm-pkg --out-name voxmpe_web",
    "build:web": "npm run build:wasm && node scripts/copy-model.mjs && tsc --noEmit -p tsconfig.web.json && vite build --mode web",
    "smoke:wasm": "node scripts/wasm-smoke.mjs",
    "preview:web": "vite preview --mode web --port 4318 --strictPort"
  },
```

- [ ] **Step 3: `studio-ui/scripts/copy-model.mjs`**

```js
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
```

- [ ] **Step 4: `studio-ui/scripts/wav.mjs`**

```js
// Test audio for the scripts: a 16-bit mono WAV writer and a sung-like phrase.

/** 16-bit PCM mono WAV bytes. */
export function wav16(samples, sr) {
  const data = samples.length * 2;
  const b = new DataView(new ArrayBuffer(44 + data));
  const text = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF"); b.setUint32(4, 36 + data, true); text(8, "WAVE");
  text(12, "fmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  text(36, "data"); b.setUint32(40, data, true);
  samples.forEach((s, i) => b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
  return new Uint8Array(b.buffer);
}

/** A4, a short silence, then C5 with vibrato: 1.4 s. */
export function phrase(sr) {
  const out = new Float32Array(Math.round(sr * 1.4));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    if (t >= 0.5 && t < 0.7) continue;
    const hz = t < 0.5 ? 440 : 523.25 * (1 + 0.01 * Math.sin(t * 35));
    phase += (2 * Math.PI * hz) / sr;
    out[i] = 0.3 * (Math.sin(phase) + 0.5 * Math.sin(2 * phase));
  }
  return out;
}
```

- [ ] **Step 5: `studio-ui/scripts/wasm-smoke.mjs`**

```js
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
```

- [ ] **Step 6: Run the smoke test and see it fail before the build exists**

Run: `cd studio-ui && npm run smoke:wasm 2>&1 | tail -2`
Expected: `Cannot find module .../src/wasm-pkg/voxmpe_web.js`.

- [ ] **Step 7: Build and run it**

Run: `cd studio-ui && npm run build:wasm 2>&1 | grep -E "Done|error" && node scripts/copy-model.mjs && npm run smoke:wasm`
Expected: `Done in ...`, `copied crepe-tiny.onnx`, `smoke ok: N notes, 1.4 s, M byte .mid` with N >= 2.

- [ ] **Step 8: Vite web mode, TypeScript configs, model README**

`studio-ui/vite.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// `npm run build` makes the local studio (served by `voxmpe studio`);
// `npm run build:web` (mode "web") makes the static site with the engine in the page.
export default defineConfig(({ mode }) =>
  mode === "web"
    ? {
        base: "./",
        publicDir: "public-web",
        // es2022: the web backend opens IndexedDB with a top-level await.
        build: { outDir: "web-dist", emptyOutDir: true, target: "es2022" },
        worker: { format: "es" },
        resolve: {
          alias: { "./backend-impl": fileURLToPath(new URL("./src/wasm-backend.ts", import.meta.url)) },
        },
      }
    : {
        build: { outDir: "../crates/voxmpe/ui-dist", emptyOutDir: true },
        // `npm run dev` with `voxmpe studio --no-open` running on 7878.
        // The studio server rejects foreign Host/Origin headers, so the dev proxy
        // presents itself as the studio's own origin.
        server: {
          proxy: {
            "/api": {
              target: "http://127.0.0.1:7878",
              changeOrigin: true,
              headers: { origin: "http://127.0.0.1:7878" },
            },
          },
        },
      },
);
```

`studio-ui/tsconfig.json`: add `"exclude": ["src/web/workers", "src/wasm-backend.ts"]` after `"include"`, so the local build type-checks without the wasm package.

`studio-ui/tsconfig.web.json`:

```json
{
  "extends": "./tsconfig.json",
  "include": ["src"],
  "exclude": []
}
```

`models/README.md`: after the paragraph about `crepe-full.onnx`, add:

```markdown
The browser studio (`npm run build:web` in `studio-ui/`) uses CREPE tiny (2 MB)
instead. Make it the same way:

    python scripts/export_crepe.py tiny
```

- [ ] **Step 9: Verify the local build is untouched**

Run: `cd studio-ui && npm run build 2>&1 | tail -1 && npx vitest run 2>&1 | grep "Tests "`
Expected: `built in ...` and all tests passing (66).

- [ ] **Step 10: Commit**

```bash
git add .gitignore models/README.md studio-ui/package.json studio-ui/vite.config.ts studio-ui/tsconfig.json studio-ui/tsconfig.web.json studio-ui/scripts
git commit -m "Web build pipeline and a WebAssembly smoke test

build:wasm packages voxmpe-web, build:web bundles the site with CREPE tiny,
smoke:wasm analyzes a phrase end to end in Node.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The `Backend` interface, with the server as one implementation

**Files:**
- Create: `studio-ui/src/backend.ts`, `studio-ui/src/server-backend.ts`, `studio-ui/src/backend-impl.ts`
- Delete: `studio-ui/src/api.ts`; rename `studio-ui/src/api.test.ts` to `studio-ui/src/server-backend.test.ts`
- Modify: `studio-ui/src/types.ts` (SavedFile, LoadResp), `studio-ui/src/export.ts` (downloadUrlData), `studio-ui/src/export.test.ts`, `studio-ui/src/renderer.ts` (ApiError import), `studio-ui/src/main.ts` (imports, calls)

**Interfaces:**
- Produces:

```ts
// backend.ts
export class ApiError extends Error { constructor(public status: number, message: string) }
export type Progress = (fraction: number) => void;
export interface Backend {
  readonly kind: "server" | "web";
  readonly canReveal: boolean;
  readonly canDelete: boolean;
  readonly canDragOut: boolean;
  listTakes(): Promise<string[]>;
  openTake(name: string, onProgress?: Progress): Promise<LoadResp>;
  uploadTake(name: string, wav: ArrayBuffer, onProgress?: Progress): Promise<LoadResp>;
  deleteTake(name: string): Promise<void>;
  render(takeId: number, settings: Settings): Promise<Rendered>;
  exportFiles(takeId: number, settings: Settings, formats: Format[]): Promise<ExportResp>;
  reveal(): Promise<void>;
  currentTake(): Promise<LoadResp | null>;
  listTunings(): Promise<Preset[]>;
  /** URL of the open take's WAV, for playback. */
  audioUrl(): string;
}
// backend-impl.ts (aliased to wasm-backend.ts in web mode)
export const backend: Backend;
```

- `types.ts`: `SavedFile { format: "mid" | "als"; path: string | null; file_name: string; url: string }`; `LoadResp { take_id: number; info: TakeInfo; cached?: boolean }`.
- `export.ts`: `downloadUrlData(f: Format, fileName: string, url: string): string`.

- [ ] **Step 1: Update the tests first**

`git mv studio-ui/src/api.test.ts studio-ui/src/server-backend.test.ts`, then in it replace the import and calls:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./backend";
import { serverBackend as api } from "./server-backend";
import { DEFAULT_SETTINGS } from "./types";
```

and change each bare call to go through `api.` (`api.render(1, DEFAULT_SETTINGS)`, `api.currentTake()`, `api.listTunings()`). Append:

```ts
  it("gives each exported file a URL the drag handle can use", async () => {
    const body = { files: [{ format: "als", path: "/t/a_studio.als", file_name: "a_studio.als" }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    const r = await api.exportFiles(1, DEFAULT_SETTINGS, ["als"]);
    expect(r.files[0].url).toBe(`${location.origin}/api/exported.als`);
    expect(r.files[0].path).toBe("/t/a_studio.als");
  });
  it("declares what only the local studio can do", () => {
    expect(api.kind).toBe("server");
    expect([api.canReveal, api.canDelete, api.canDragOut]).toEqual([true, false, true]);
  });
```

Add `// @vitest-environment jsdom` as the file's first line (it now reads `location`).

In `export.test.ts`, change the DownloadURL test to:

```ts
  it("builds Chrome's DownloadURL value per format", () => {
    expect(downloadUrlData("mid", "take1_studio.mid", "http://127.0.0.1:7878/api/exported.mid")).toBe(
      "audio/midi:take1_studio.mid:http://127.0.0.1:7878/api/exported.mid",
    );
    expect(downloadUrlData("als", "take1_studio.als", "blob:http://x/1234")).toBe(
      "application/octet-stream:take1_studio.als:blob:http://x/1234",
    );
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio-ui && npx vitest run src/server-backend.test.ts src/export.test.ts 2>&1 | grep -E "Error|Tests "`
Expected: `Cannot find module './backend'` and the export test failing.

- [ ] **Step 3: Implement**

`studio-ui/src/backend.ts`:

```ts
import type { Format } from "./export";
import type { ExportResp, LoadResp, Preset, Rendered, Settings } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Analysis progress, 0 to 1. */
export type Progress = (fraction: number) => void;

/** Everything the studio page needs from an engine: the local server, or WebAssembly in the page. */
export interface Backend {
  readonly kind: "server" | "web";
  readonly canReveal: boolean;
  readonly canDelete: boolean;
  readonly canDragOut: boolean;
  listTakes(): Promise<string[]>;
  openTake(name: string, onProgress?: Progress): Promise<LoadResp>;
  uploadTake(name: string, wav: ArrayBuffer, onProgress?: Progress): Promise<LoadResp>;
  deleteTake(name: string): Promise<void>;
  render(takeId: number, settings: Settings): Promise<Rendered>;
  exportFiles(takeId: number, settings: Settings, formats: Format[]): Promise<ExportResp>;
  reveal(): Promise<void>;
  currentTake(): Promise<LoadResp | null>;
  listTunings(): Promise<Preset[]>;
  /** URL of the open take's WAV, for playback. */
  audioUrl(): string;
}
```

`studio-ui/src/server-backend.ts` (today's `api.ts`, as an object):

```ts
import { ApiError, type Backend } from "./backend";
import type { ExportResp, LoadResp, Preset, Rendered } from "./types";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new ApiError(res.status, res.statusText || "request failed");
    throw new ApiError(res.status, "unexpected response from the studio");
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The local studio: `voxmpe studio` serves this page and runs the engine natively. */
export const serverBackend: Backend = {
  kind: "server",
  canReveal: true,
  canDelete: false,
  canDragOut: true,
  listTakes: () => call<string[]>("/api/takes"),
  openTake: (name) => call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST" }),
  uploadTake: (name, wav) =>
    call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST", body: wav }),
  deleteTake: async () => {
    throw new ApiError(405, "takes are files in takes/; delete them in Finder");
  },
  render: (takeId, settings) => call<Rendered>("/api/render", post({ take_id: takeId, settings })),
  async exportFiles(takeId, settings, formats) {
    const r = await call<ExportResp>("/api/export", post({ take_id: takeId, settings, formats }));
    return { files: r.files.map((f) => ({ ...f, url: `${location.origin}/api/exported.${f.format}` })) };
  },
  reveal: () => call<void>("/api/reveal", { method: "POST" }),
  /** The take the studio already has open (e.g. `voxmpe studio take.wav`), or null. */
  async currentTake() {
    const res = await fetch("/api/current");
    if (res.status === 204) return null;
    if (!res.ok) throw new ApiError(res.status, res.statusText || "request failed");
    return (await res.json()) as LoadResp;
  },
  listTunings: () => call<Preset[]>("/api/tunings"),
  audioUrl: () => "/api/audio",
};
```

`studio-ui/src/backend-impl.ts`:

```ts
// The engine this build talks to. Vite's web mode aliases this file to
// wasm-backend.ts; everything else (the local studio, tests) gets the server.
export { serverBackend as backend } from "./server-backend";
```

`types.ts`: set `SavedFile` to `{ format: "mid" | "als"; path: string | null; file_name: string; url: string }` and add `cached?: boolean;` to `LoadResp` with the comment `/** True when the analysis came from the browser's cache. */`.

`export.ts`: replace `exportedUrl` and `downloadUrlData` with:

```ts
export const downloadUrlData = (f: Format, fileName: string, url: string) => `${MIME[f]}:${fileName}:${url}`;
```

`renderer.ts`: `import { ApiError } from "./backend";`

`main.ts`:
- Replace `import * as api from "./api";` and `import { AUDIO_URL, currentTake } from "./api";` with `import { backend as api } from "./backend-impl";`.
- `currentTake()` at the bottom becomes `api.currentTake()`; `api.listTunings()` stays.
- In `opened`: `await player.load(api.audioUrl());`
- In the drag handler: `downloadUrlData(f.format, f.file_name, f.url)`.
- After Save: `$("saved-path").textContent = r.files.map((f) => f.path ?? f.file_name).join("  ");` and `$("reveal").hidden = !api.canReveal;`

- [ ] **Step 4: Run all UI tests and both type checks**

Run: `cd studio-ui && npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |FAIL"`
Expected: no tsc output; `Tests  68 passed`.

- [ ] **Step 5: Commit**

```bash
git add -A studio-ui/src
git commit -m "Studio: a Backend interface, the server as its first implementation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The IndexedDB take store and analysis cache

**Files:**
- Create: `studio-ui/src/web/take-store.ts`, `studio-ui/src/web/take-store.test.ts`
- Modify: `studio-ui/package.json` (dev dependency `fake-indexeddb`)

**Interfaces:**
- Produces:

```ts
export const MODEL_ID = "crepe-tiny";
export function sanitizeStem(raw: string): string;
export interface TakeStore {
  list(): Promise<string[]>;                       // names, sorted
  get(name: string): Promise<{ wav: ArrayBuffer; frames: Float32Array | null } | null>;
  add(requested: string, wav: ArrayBuffer): Promise<string>;  // the stored `<stem>[-N].wav`
  setFrames(name: string, frames: Float32Array): Promise<void>;
  remove(name: string): Promise<void>;
}
export function openTakeStore(factory?: IDBFactory): Promise<TakeStore>;
```

- [ ] **Step 1: Install the dev dependency**

Run: `cd studio-ui && npm i -D fake-indexeddb@6`
Expected: `added 1 package`.

- [ ] **Step 2: Write the failing tests** (`studio-ui/src/web/take-store.test.ts`)

```ts
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MODEL_ID, openTakeStore, sanitizeStem } from "./take-store";

const bytes = (n: number) => new Uint8Array([n, n, n]).buffer;

describe("sanitizeStem (same rules as the server)", () => {
  it("keeps letters, digits, - and _, and trims to 60", () => {
    expect(sanitizeStem("my take!")).toBe("my-take");
    expect(sanitizeStem("../../evil.wav")).toBe("evil");
    expect(sanitizeStem("a  b..c")).toBe("a-b-c");
    expect(sanitizeStem("!!!")).toBe("take");
    expect(sanitizeStem("x".repeat(80))).toHaveLength(60);
  });
});

describe("take store", () => {
  it("names are sanitized and never overwrite", async () => {
    const s = await openTakeStore(new IDBFactory());
    expect(await s.add("my take!", bytes(1))).toBe("my-take.wav");
    expect(await s.add("my take!", bytes(2))).toBe("my-take-2.wav");
    expect(await s.list()).toEqual(["my-take-2.wav", "my-take.wav"]);
    expect(new Uint8Array((await s.get("my-take.wav"))!.wav)[0]).toBe(1);
  });

  it("caches the analysis and forgets it with the take", async () => {
    const s = await openTakeStore(new IDBFactory());
    const name = await s.add("a", bytes(1));
    expect((await s.get(name))!.frames).toBeNull();
    await s.setFrames(name, new Float32Array([0.01, 1, 2]));
    expect(Array.from((await s.get(name))!.frames!)).toEqual([0.01, 1, 2].map(Math.fround));
    await s.remove(name);
    expect(await s.get(name)).toBeNull();
    expect(await s.list()).toEqual([]);
  });

  it("frames from another model are ignored", async () => {
    const factory = new IDBFactory();
    const s = await openTakeStore(factory);
    const name = await s.add("a", bytes(1));
    // Write a record as an older build with another model would have.
    await new Promise<void>((done) => {
      const open = factory.open("voxmpe");
      open.onsuccess = () => {
        const tx = open.result.transaction("takes", "readwrite");
        const store = tx.objectStore("takes");
        const get = store.get(name);
        get.onsuccess = () => store.put({ ...get.result, frames: new Float32Array([1]), model: "crepe-full" });
        tx.oncomplete = () => done();
      };
    });
    expect(MODEL_ID).toBe("crepe-tiny");
    expect((await s.get(name))!.frames).toBeNull();
  });

  it("persists across opens", async () => {
    const factory = new IDBFactory();
    await (await openTakeStore(factory)).add("kept", bytes(3));
    expect(await (await openTakeStore(factory)).list()).toEqual(["kept.wav"]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd studio-ui && npx vitest run src/web/take-store.test.ts 2>&1 | grep -E "Error|Tests "`
Expected: `Cannot find module './take-store'`.

- [ ] **Step 4: Implement `studio-ui/src/web/take-store.ts`**

```ts
// Takes and their analysis, kept in this browser (IndexedDB). Nothing is uploaded.

/** The model the cached analysis came from; a different model means re-analyze. */
export const MODEL_ID = "crepe-tiny";

const DB = "voxmpe";
const STORE = "takes";

interface Row {
  name: string;
  wav: ArrayBuffer;
  frames: Float32Array | null;
  model: string | null;
  created: number;
}

/** A take name safe to store and show: the server's rules (see server.rs `sanitize_stem`). */
export function sanitizeStem(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/\.wav$/, "");
  const s = [...base]
    .map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "-"))
    .join("")
    .split("-")
    .filter(Boolean)
    .join("-");
  return s ? [...s].slice(0, 60).join("") : "take";
}

export interface TakeStore {
  list(): Promise<string[]>;
  get(name: string): Promise<{ wav: ArrayBuffer; frames: Float32Array | null } | null>;
  add(requested: string, wav: ArrayBuffer): Promise<string>;
  setFrames(name: string, frames: Float32Array): Promise<void>;
  remove(name: string): Promise<void>;
}

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((ok, fail) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });

export async function openTakeStore(factory: IDBFactory = indexedDB): Promise<TakeStore> {
  const open = factory.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "name" });
  const db = await done(open);
  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);

  return {
    async list() {
      const keys = await done(store("readonly").getAllKeys());
      return (keys as string[]).sort();
    },
    async get(name) {
      const row = (await done(store("readonly").get(name))) as Row | undefined;
      if (!row) return null;
      return { wav: row.wav, frames: row.model === MODEL_ID ? row.frames : null };
    },
    async add(requested, wav) {
      const stem = sanitizeStem(requested);
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const taken = new Set((await done(s.getAllKeys())) as string[]);
      let name = `${stem}.wav`;
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.wav`;
      const row: Row = { name, wav, frames: null, model: null, created: Date.now() };
      s.add(row);
      await finished(tx);
      return name;
    },
    async setFrames(name, frames) {
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const row = (await done(s.get(name))) as Row | undefined;
      if (row) s.put({ ...row, frames, model: MODEL_ID });
      await finished(tx);
    },
    async remove(name) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(name);
      await finished(tx);
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd studio-ui && npx vitest run src/web/take-store.test.ts 2>&1 | grep -E "Tests |FAIL"`
Expected: `Tests  5 passed (5)`.

- [ ] **Step 6: Commit**

```bash
git add studio-ui/package.json studio-ui/package-lock.json studio-ui/src/web
git commit -m "Studio web: IndexedDB take store with an analysis cache

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Pitch pool orchestration and the two workers

**Files:**
- Create: `studio-ui/src/web/pool.ts`, `studio-ui/src/web/pool.test.ts`
- Create: `studio-ui/src/web/workers/pitch.worker.ts`, `studio-ui/src/web/workers/studio.worker.ts`
- Create: `studio-ui/src/web/clients.ts`

**Interfaces:**
- Consumes: Task 4's `PitchWorker`, `Studio`, `tunings` from `../../wasm-pkg/voxmpe_web.js`.
- Produces:

```ts
// pool.ts
export const BATCH = 32;
export interface PitchJob { run(audio16: Float32Array, indices: Uint32Array): Promise<Float32Array> }
export function shares(active: Uint32Array, parts: number): Uint32Array[];
export function runShares(jobs: PitchJob[], audio16: Float32Array, parts: Uint32Array[], onProgress: (f: number) => void): Promise<Float32Array>;
export function workerCount(cores: number | undefined): number; // clamp 2..8
// clients.ts
export interface StudioClient {
  load(name: string, wav: ArrayBuffer): Promise<{ audio16: Float32Array; active: Uint32Array }>;
  finish(results: Float32Array): Promise<{ info: TakeInfo; frames: Float32Array }>;
  restore(name: string, wav: ArrayBuffer, frames: Float32Array): Promise<TakeInfo>;
  render(settings: Settings): Promise<Rendered>;
  exportFile(settings: Settings, format: Format): Promise<Uint8Array>;
  tunings(): Promise<Preset[]>;
}
export function studioClient(worker: Worker): StudioClient;
export function pitchJob(worker: Worker, model: ArrayBuffer): Promise<PitchJob>;
```

Worker messages: a request is `{ id: number; method: string; args: unknown[] }`, a reply is `{ id: number; ok: true; value: unknown } | { id: number; ok: false; message: string }`. The pitch worker's methods are `init(model: ArrayBuffer)` and `run(audio16, indices)`; the studio worker's are `load`, `finish`, `restore`, `render`, `export`, `tunings`.

- [ ] **Step 1: Write the failing tests** (`studio-ui/src/web/pool.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { BATCH, runShares, shares, workerCount, type PitchJob } from "./pool";

const range = (n: number) => Uint32Array.from({ length: n }, (_, i) => i * 2);

/** A job that echoes each index as its "f0" after `delay(i)` ms. */
const echo = (delay: (first: number) => number): PitchJob => ({
  run: (_a, idx) =>
    new Promise((ok) =>
      setTimeout(() => ok(Float32Array.from([...idx].flatMap((i) => [i, 1]))), delay(idx[0] ?? 0)),
    ),
});

describe("shares", () => {
  it("splits in order into whole batches, the last one shorter", () => {
    const parts = shares(range(200), 4);
    expect(parts.flatMap((p) => [...p])).toEqual([...range(200)]);
    for (const p of parts.slice(0, -1)) expect(p.length % BATCH).toBe(0);
    expect(parts.length).toBe(4);
  });
  it("never makes more shares than batches, nor empty ones", () => {
    expect(shares(range(40), 8).length).toBe(2);
    expect(shares(new Uint32Array(), 4)).toEqual([]);
  });
});

describe("runShares", () => {
  it("returns results in frame order even when shares finish out of order", async () => {
    const parts = shares(range(300), 6);
    const progress: number[] = [];
    const out = await runShares([echo((i) => 30 - i / 20), echo(() => 1)], new Float32Array(), parts, (f) => progress.push(f));
    expect([...out].filter((_, i) => i % 2 === 0)).toEqual([...range(300)]);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });
  it("finishes at once when there is nothing to analyze", async () => {
    const progress: number[] = [];
    expect((await runShares([echo(() => 1)], new Float32Array(), [], (f) => progress.push(f))).length).toBe(0);
    expect(progress).toEqual([1]);
  });
  it("fails with a message when a worker crashes, and stops handing out shares", async () => {
    let runs = 0;
    const crash: PitchJob = { run: async () => { runs++; throw new Error("worker died"); } };
    const e = await runShares([crash], new Float32Array(), shares(range(400), 8), () => {}).catch((x) => x);
    expect(e.message).toBe("Analysis failed: worker died");
    expect(runs).toBe(1);
  });
});

describe("workerCount", () => {
  it("uses the cores, 2 to 8", () => {
    expect([workerCount(undefined), workerCount(1), workerCount(6), workerCount(16)]).toEqual([2, 2, 6, 8]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio-ui && npx vitest run src/web/pool.test.ts 2>&1 | grep -E "Error|Tests "`
Expected: `Cannot find module './pool'`.

- [ ] **Step 3: Implement `studio-ui/src/web/pool.ts`**

```ts
// Splitting a take's active frames across pitch workers and putting the
// results back in order. Pure, so it is tested without real workers.

/** Frames per model run; shares are whole batches so none is padded mid-take. */
export const BATCH = 32;
/** Shares per worker: more shares than workers keeps every worker busy and progress smooth. */
const SHARES_PER_WORKER = 4;

export interface PitchJob {
  run(audio16: Float32Array, indices: Uint32Array): Promise<Float32Array>;
}

/** Split `active` into at most `parts` contiguous shares of whole batches (the last may be shorter). */
export function shares(active: Uint32Array, parts: number): Uint32Array[] {
  const batches = Math.ceil(active.length / BATCH);
  if (!batches) return [];
  const per = Math.ceil(batches / Math.max(1, Math.min(parts, batches))) * BATCH;
  const out: Uint32Array[] = [];
  for (let i = 0; i < active.length; i += per) out.push(active.slice(i, i + per));
  return out;
}

/** Run every share on the jobs (each takes the next free share); results in share order. */
export async function runShares(
  jobs: PitchJob[],
  audio16: Float32Array,
  parts: Uint32Array[],
  onProgress: (fraction: number) => void,
): Promise<Float32Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const results: Float32Array[] = new Array(parts.length);
  let next = 0;
  let doneFrames = 0;
  let failed: Error | null = null;
  const worker = async (job: PitchJob) => {
    while (!failed && next < parts.length) {
      const i = next++;
      try {
        results[i] = await job.run(audio16, parts[i]);
      } catch (e) {
        failed ??= new Error(`Analysis failed: ${(e as Error).message}`);
        return;
      }
      doneFrames += parts[i].length;
      onProgress(doneFrames / total);
    }
  };
  await Promise.all(jobs.map(worker));
  if (failed) throw failed;
  if (!parts.length) onProgress(1);
  const out = new Float32Array(total * 2);
  let at = 0;
  for (const r of results) {
    out.set(r, at);
    at += r.length;
  }
  return out;
}

/** How many shares to cut for `workers` workers. */
export const shareCount = (workers: number) => workers * SHARES_PER_WORKER;

/** One pitch worker per core, 2 to 8. */
export const workerCount = (cores: number | undefined) => Math.min(8, Math.max(2, cores ?? 2));
```

- [ ] **Step 4: Run the tests**

Run: `cd studio-ui && npx vitest run src/web/pool.test.ts 2>&1 | grep -E "Tests |FAIL"`
Expected: `Tests  6 passed (6)`.

- [ ] **Step 5: The workers and their clients** (exercised by Tasks 9 and 11)

`studio-ui/src/web/workers/pitch.worker.ts`:

```ts
// One CREPE tiny model; runs shares of frames for the page.
import init, { PitchWorker } from "../../wasm-pkg/voxmpe_web.js";

let model: PitchWorker | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; method: string; args: any[] }>) => {
  const { id, method, args } = e.data;
  try {
    if (method === "init") {
      await init();
      model = new PitchWorker(new Uint8Array(args[0]));
      self.postMessage({ id, ok: true, value: null });
    } else if (method === "run") {
      const out = model!.run(args[0], args[1]);
      self.postMessage({ id, ok: true, value: out }, { transfer: [out.buffer] });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, message: (err as Error).message });
  }
};
```

`studio-ui/src/web/workers/studio.worker.ts`:

```ts
// The open take: decode, assemble, render and export, all in this worker.
import init, { Studio, tunings } from "../../wasm-pkg/voxmpe_web.js";

const ready = init();
let studio: Studio | null = null;

const methods: Record<string, (...a: any[]) => unknown> = {
  load(name: string, wav: ArrayBuffer) {
    studio = new Studio();
    studio.load(name, new Uint8Array(wav));
    return { audio16: studio.audio16(), active: studio.active() };
  },
  finish(results: Float32Array) {
    const info = JSON.parse(studio!.finish(results));
    return { info, frames: studio!.frames() };
  },
  restore(name: string, wav: ArrayBuffer, frames: Float32Array) {
    studio = new Studio();
    return JSON.parse(studio.restore(name, new Uint8Array(wav), frames));
  },
  render: (settings: string) => JSON.parse(studio!.render(settings)),
  export: (settings: string, format: string) => studio!.export(settings, format),
  tunings: () => JSON.parse(tunings()),
};

self.onmessage = async (e: MessageEvent<{ id: number; method: string; args: any[] }>) => {
  const { id, method, args } = e.data;
  try {
    await ready;
    if (!studio && method !== "load" && method !== "restore" && method !== "tunings") throw new Error("no take is open");
    self.postMessage({ id, ok: true, value: methods[method](...args) });
  } catch (err) {
    self.postMessage({ id, ok: false, message: (err as Error).message });
  }
};
```

`studio-ui/src/web/clients.ts`:

```ts
// Promise wrappers around the two workers' message protocol.
import { ApiError } from "../backend";
import type { Format } from "../export";
import type { Preset, Rendered, Settings, TakeInfo } from "../types";
import type { PitchJob } from "./pool";

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

/** Call `method` on `worker`; engine errors become ApiError 400, as the server's would. */
function rpc(worker: Worker) {
  let next = 0;
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const w = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (!w) return;
    if (e.data.ok) w.ok(e.data.value);
    else w.fail(new ApiError(400, e.data.message));
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.fail(new Error(e.message || "the engine stopped"));
    waiting.clear();
  };
  return <T>(method: string, args: unknown[], transfer: Transferable[] = []) =>
    new Promise<T>((ok, fail) => {
      const id = next++;
      waiting.set(id, { ok, fail });
      worker.postMessage({ id, method, args }, transfer);
    });
}

export interface StudioClient {
  load(name: string, wav: ArrayBuffer): Promise<{ audio16: Float32Array; active: Uint32Array }>;
  finish(results: Float32Array): Promise<{ info: TakeInfo; frames: Float32Array }>;
  restore(name: string, wav: ArrayBuffer, frames: Float32Array): Promise<TakeInfo>;
  render(settings: Settings): Promise<Rendered>;
  exportFile(settings: Settings, format: Format): Promise<Uint8Array>;
  tunings(): Promise<Preset[]>;
}

export function studioClient(worker: Worker): StudioClient {
  const call = rpc(worker);
  return {
    load: (name, wav) => call("load", [name, wav.slice(0)]),
    finish: (results) => call("finish", [results]),
    restore: (name, wav, frames) => call("restore", [name, wav.slice(0), frames]),
    render: (s) => call("render", [JSON.stringify(s)]),
    exportFile: (s, f) => call("export", [JSON.stringify(s), f]),
    tunings: () => call("tunings", []),
  };
}

/** A pitch worker with the model loaded. */
export async function pitchJob(worker: Worker, model: ArrayBuffer): Promise<PitchJob> {
  const call = rpc(worker);
  await call("init", [model.slice(0)]);
  return { run: (audio16, indices) => call("run", [audio16, indices]) };
}
```

- [ ] **Step 6: Type-check the web sources**

Run: `cd studio-ui && npm run build:wasm >/dev/null 2>&1; npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -5`
Expected: no output. (`wasm-backend.ts` does not exist yet; if tsc reports it missing from the alias, that is Task 9's file.)

- [ ] **Step 7: Commit**

```bash
git add studio-ui/src/web
git commit -m "Studio web: pitch pool orchestration and the two workers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The WebAssembly backend and the support check

**Files:**
- Create: `studio-ui/src/wasm-backend.ts`, `studio-ui/src/web/web-backend.ts`, `studio-ui/src/web/web-backend.test.ts`
- Create: `studio-ui/src/web/support.ts`, `studio-ui/src/web/support.test.ts`

**Interfaces:**
- Consumes: Task 6 (`Backend`, `ApiError`), Task 7 (`TakeStore`), Task 8 (`StudioClient`, `PitchJob`, `shares`, `shareCount`, `runShares`, `workerCount`, `studioClient`, `pitchJob`).
- Produces:

```ts
// web/web-backend.ts (testable, no workers)
export interface WebDeps {
  store: TakeStore;
  studio: StudioClient;
  pitch(): Promise<PitchJob[]>;               // started once, on first analysis
  objectUrl(bytes: BlobPart, type: string): string;
  download(url: string, fileName: string): void;
}
export function createWebBackend(deps: WebDeps, canDragOut: boolean): Backend;
// wasm-backend.ts
export const backend: Backend;                 // real workers, IndexedDB, fetch("./crepe-tiny.onnx")
// web/support.ts
export function missingFeatures(env?: { WebAssembly?: any; Worker?: unknown; indexedDB?: unknown }): string[];
```

- [ ] **Step 1: Write the failing tests**

`studio-ui/src/web/support.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { missingFeatures } from "./support";

describe("missingFeatures", () => {
  it("finds nothing missing where SIMD, workers and IndexedDB exist", () => {
    // Node validates the SIMD probe for real, so this also checks the probe bytes.
    expect(missingFeatures({ WebAssembly, Worker: class {}, indexedDB: {} })).toEqual([]);
  });
  it("names what is missing, in plain words", () => {
    expect(missingFeatures({ WebAssembly: { validate: () => false }, Worker: undefined, indexedDB: undefined })).toEqual([
      "WebAssembly SIMD",
      "Web Workers",
      "IndexedDB",
    ]);
    expect(missingFeatures({})).toContain("WebAssembly SIMD");
  });
});
```

`studio-ui/src/web/web-backend.test.ts`:

```ts
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../backend";
import type { StudioClient } from "./clients";
import { createWebBackend, type WebDeps } from "./web-backend";
import { openTakeStore } from "./take-store";
import { DEFAULT_SETTINGS, type TakeInfo } from "../types";

const info = (name: string): TakeInfo => ({ name, duration_s: 1, hop_s: 0.01, contour: [], loudness: [], warning: null });

function fakeStudio(): StudioClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load: async (name) => (calls.push(`load ${name}`), { audio16: new Float32Array(10), active: Uint32Array.from([0, 1, 2]) }),
    finish: async (r) => (calls.push(`finish ${r.length}`), { info: info("a.wav"), frames: new Float32Array([0.01, 9]) }),
    restore: async (name) => (calls.push(`restore ${name}`), info(name)),
    render: async () => ({ notes: [], flags: "" }),
    exportFile: async (_s, f) => (calls.push(`export ${f}`), new Uint8Array([f === "mid" ? 1 : 2])),
    tunings: async () => [],
  };
}

async function setup() {
  const studio = fakeStudio();
  const downloads: string[] = [];
  const deps: WebDeps = {
    store: await openTakeStore(new IDBFactory()),
    studio,
    pitch: vi.fn(async () => [{ run: async (_a: Float32Array, idx: Uint32Array) => new Float32Array(idx.length * 2) }]),
    objectUrl: (_b, type) => `blob:${type}`,
    download: (_u, name) => downloads.push(name),
  };
  return { backend: createWebBackend(deps, true), studio, deps, downloads };
}

describe("web backend", () => {
  it("analyzes a new take across the pitch workers and caches the result", async () => {
    const { backend, studio, deps } = await setup();
    const progress: number[] = [];
    const r = await backend.uploadTake("a", new ArrayBuffer(8), (f) => progress.push(f));
    expect(r.info.name).toBe("a.wav");
    expect(r.cached).toBe(false);
    expect(studio.calls).toEqual(["load a.wav", "finish 6"]);
    expect(progress.at(-1)).toBe(1);
    expect(Array.from((await deps.store.get("a.wav"))!.frames!)).toEqual([0.01, 9].map(Math.fround));
    expect(await backend.listTakes()).toEqual(["a.wav"]);
    expect(backend.audioUrl()).toBe("blob:audio/wav");
  });

  it("reopens a cached take without analysis", async () => {
    const { backend, studio, deps } = await setup();
    await backend.uploadTake("a", new ArrayBuffer(8));
    const r = await backend.openTake("a.wav");
    expect(r.cached).toBe(true);
    expect(studio.calls.at(-1)).toBe("restore a.wav");
    expect(deps.pitch).toHaveBeenCalledTimes(1);
    expect(r.take_id).toBeGreaterThan(0);
  });

  it("saves each ticked format as a download with a drag URL", async () => {
    const { backend, downloads } = await setup();
    const { take_id } = await backend.uploadTake("a", new ArrayBuffer(8));
    const r = await backend.exportFiles(take_id, DEFAULT_SETTINGS, ["mid", "als"]);
    expect(downloads).toEqual(["a_studio.mid", "a_studio.als"]);
    expect(r.files.map((f) => [f.format, f.path, f.url])).toEqual([
      ["mid", null, "blob:audio/midi"],
      ["als", null, "blob:application/octet-stream"],
    ]);
  });

  it("rejects work on a take that is no longer open, like the server's 409", async () => {
    const { backend } = await setup();
    const { take_id } = await backend.uploadTake("a", new ArrayBuffer(8));
    await backend.uploadTake("b", new ArrayBuffer(8));
    const e = await backend.render(take_id, DEFAULT_SETTINGS).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
  });

  it("engine errors become ApiError 400 and a failed analysis caches nothing", async () => {
    const { backend, deps } = await setup();
    deps.studio.load = async () => {
      throw new ApiError(400, "this take is 11 minutes long; the browser studio takes up to 10 minutes");
    };
    const e = await backend.uploadTake("long", new ArrayBuffer(8)).catch((x) => x);
    expect(e.status).toBe(400);
    expect(e.message).toContain("10 minutes");
    expect((await deps.store.get("long.wav"))!.frames).toBeNull();
  });

  it("deletes takes and declares its abilities", async () => {
    const { backend } = await setup();
    await backend.uploadTake("a", new ArrayBuffer(8));
    await backend.deleteTake("a.wav");
    expect(await backend.listTakes()).toEqual([]);
    expect([backend.kind, backend.canReveal, backend.canDelete, backend.canDragOut]).toEqual(["web", false, true, true]);
    expect(await backend.currentTake()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio-ui && npx vitest run src/web/support.test.ts src/web/web-backend.test.ts 2>&1 | grep -E "Error|Tests "`
Expected: `Cannot find module './support'` and `'./web-backend'`.

- [ ] **Step 3: Implement `studio-ui/src/web/support.ts`**

```ts
// What the browser studio needs, checked before anything loads.

/** A tiny module using a SIMD instruction (from wasm-feature-detect). */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function missingFeatures(env: { WebAssembly?: any; Worker?: unknown; indexedDB?: unknown } = globalThis as any): string[] {
  const missing: string[] = [];
  let simd = false;
  try {
    simd = !!env.WebAssembly?.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  if (!simd) missing.push("WebAssembly SIMD");
  if (typeof env.Worker !== "function") missing.push("Web Workers");
  if (!env.indexedDB) missing.push("IndexedDB");
  return missing;
}
```

- [ ] **Step 4: Implement `studio-ui/src/web/web-backend.ts`**

```ts
// The studio's engine in the page: takes in IndexedDB, analysis on pitch
// workers, everything else in the studio worker.
import { ApiError, type Backend, type Progress } from "../backend";
import type { Format } from "../export";
import type { LoadResp, SavedFile } from "../types";
import type { StudioClient } from "./clients";
import { runShares, shareCount, shares, type PitchJob } from "./pool";
import type { TakeStore } from "./take-store";

export interface WebDeps {
  store: TakeStore;
  studio: StudioClient;
  /** The pitch workers, started on the first analysis and kept. */
  pitch(): Promise<PitchJob[]>;
  objectUrl(bytes: BlobPart, type: string): string;
  download(url: string, fileName: string): void;
}

const MIME: Record<Format, string> = { mid: "audio/midi", als: "application/octet-stream" };

export function createWebBackend(deps: WebDeps, canDragOut: boolean): Backend {
  let takeId = 0;
  let open: { name: string; audioUrl: string } | null = null;
  let jobs: Promise<PitchJob[]> | null = null;

  async function openStored(name: string, onProgress?: Progress): Promise<LoadResp> {
    const stored = await deps.store.get(name);
    if (!stored) throw new ApiError(404, `no take named ${name}`);
    let info;
    let cached = false;
    if (stored.frames) {
      info = await deps.studio.restore(name, stored.wav, stored.frames);
      cached = true;
    } else {
      const { audio16, active } = await deps.studio.load(name, stored.wav);
      const pool = await (jobs ??= deps.pitch());
      const results = await runShares(pool, audio16, shares(active, shareCount(pool.length)), onProgress ?? (() => {}));
      const done = await deps.studio.finish(results);
      await deps.store.setFrames(name, done.frames);
      info = done.info;
    }
    open = { name, audioUrl: deps.objectUrl(stored.wav, "audio/wav") };
    return { take_id: ++takeId, info, cached };
  }

  const current = (id: number) => {
    if (!open || id !== takeId) throw new ApiError(409, "that take is no longer open");
    return open;
  };

  return {
    kind: "web",
    canReveal: false,
    canDelete: true,
    canDragOut,
    listTakes: () => deps.store.list(),
    openTake: openStored,
    async uploadTake(name, wav, onProgress) {
      return openStored(await deps.store.add(name, wav), onProgress);
    },
    deleteTake: (name) => deps.store.remove(name),
    async render(id, settings) {
      current(id);
      return deps.studio.render(settings);
    },
    async exportFiles(id, settings, formats) {
      const { name } = current(id);
      const stem = name.replace(/\.wav$/, "");
      const files: SavedFile[] = [];
      for (const format of formats) {
        const bytes = await deps.studio.exportFile(settings, format);
        const file_name = `${stem}_studio.${format}`;
        const url = deps.objectUrl(bytes, MIME[format]);
        deps.download(url, file_name);
        files.push({ format, path: null, file_name, url });
      }
      return { files };
    },
    reveal: async () => {},
    currentTake: async () => null,
    listTunings: () => deps.studio.tunings(),
    audioUrl: () => open?.audioUrl ?? "",
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd studio-ui && npx vitest run src/web 2>&1 | grep -E "Tests |FAIL"`
Expected: `Tests  19 passed` (5 store + 6 pool + 2 support + 6 backend).

- [ ] **Step 6: The real wiring, `studio-ui/src/wasm-backend.ts`**

Set `CAN_DRAG_OUT` from Task 1's ruling.

```ts
// The browser build's engine (vite aliases ./backend-impl to this file in web mode).
import type { Backend } from "./backend";
import { pitchJob, studioClient } from "./web/clients";
import { workerCount } from "./web/pool";
import { openTakeStore } from "./web/take-store";
import { createWebBackend } from "./web/web-backend";

/** From the drag-out check (plan Task 1): does Chrome drag a blob: DownloadURL out? */
const CAN_DRAG_OUT = true;

const studioWorker = () => new Worker(new URL("./web/workers/studio.worker.ts", import.meta.url), { type: "module" });
const pitchWorker = () => new Worker(new URL("./web/workers/pitch.worker.ts", import.meta.url), { type: "module" });

async function loadModel(): Promise<ArrayBuffer> {
  const res = await fetch("./crepe-tiny.onnx");
  if (!res.ok) throw new Error(`could not download the pitch model (${res.status})`);
  return res.arrayBuffer();
}

const store = await openTakeStore();

export const backend: Backend = createWebBackend(
  {
    store,
    studio: studioClient(studioWorker()),
    async pitch() {
      const model = await loadModel();
      const n = workerCount(navigator.hardwareConcurrency);
      return Promise.all(Array.from({ length: n }, () => pitchJob(pitchWorker(), model)));
    },
    objectUrl: (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })),
    download(url, fileName) {
      const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
      a.click();
    },
  },
  CAN_DRAG_OUT,
);
```

- [ ] **Step 7: Build the site**

Run: `cd studio-ui && npm run build:web 2>&1 | tail -3`
Expected: `built in ...`; `ls web-dist` shows `index.html`, `assets/`, `crepe-tiny.onnx`.

- [ ] **Step 8: Commit**

```bash
git add studio-ui/src/wasm-backend.ts studio-ui/src/web
git commit -m "Studio web: the WebAssembly backend and a browser support check

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Studio page changes: progress, delete, privacy, settings memory, support message

**Files:**
- Modify: `studio-ui/src/settings-store.ts`, `studio-ui/src/settings-store.test.ts`
- Modify: `studio-ui/src/main.ts`, `studio-ui/index.html`, `studio-ui/src/styles.css`

**Interfaces:**
- Consumes: Task 6 `Backend` flags and `Progress`, Task 9 `missingFeatures`.
- Produces: `loadSettings(storage: Storage, defaults: Settings): Settings`, `saveSettings(storage: Storage, s: Settings): void`.

- [ ] **Step 1: Write the failing tests** (append to `settings-store.test.ts`; add `loadSettings, saveSettings` to its import from `./settings-store`)

```ts
describe("settings memory", () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } };
  };

  it("remembers the last settings", () => {
    const s = memory();
    saveSettings(s, { ...DEFAULT_SETTINGS, hold_ms: 95, tuning_name: "31-edo", onset_delta: null });
    expect(loadSettings(s, DEFAULT_SETTINGS)).toEqual({ ...DEFAULT_SETTINGS, hold_ms: 95, tuning_name: "31-edo", onset_delta: null });
  });

  it("loadSettings keeps only known, well-typed keys", () => {
    const s = memory();
    s.setItem("voxmpe.settings", JSON.stringify({ hold_ms: "fast", gap_ms: 120, bogus: 1, tuning_scl: 5 }));
    expect(loadSettings(s, DEFAULT_SETTINGS)).toEqual({ ...DEFAULT_SETTINGS, gap_ms: 120 });
    s.setItem("voxmpe.settings", "{");
    expect(loadSettings(s, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("works without storage", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(loadSettings(broken, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(broken, DEFAULT_SETTINGS)).not.toThrow();
  });
});
```

(Import `DEFAULT_SETTINGS` from `./types` if the file does not already.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio-ui && npx vitest run src/settings-store.test.ts 2>&1 | grep -E "not a function|Tests "`
Expected: `loadSettings is not a function`.

- [ ] **Step 3: Implement** (append to `settings-store.ts`)

```ts
const KEY = "voxmpe.settings";

/** Keys that may be null ("none" / "off"), and the type they hold otherwise. */
const NULLABLE: Partial<Record<keyof Settings, "string" | "number">> = {
  tuning_name: "string",
  tuning_scl: "string",
  single_channel: "number",
  onset_delta: "number",
};

/** Whether a remembered `value` may stand in for setting `key`. */
function fits(key: keyof Settings, value: unknown, defaults: Settings): boolean {
  const nullable = NULLABLE[key];
  if (nullable) return value === null || typeof value === nullable;
  return typeof value === typeof defaults[key];
}

/** The remembered settings over `defaults`; unknown or ill-typed keys keep the default. */
export function loadSettings(storage: Storage, defaults: Settings): Settings {
  try {
    const saved: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (!saved || typeof saved !== "object") return { ...defaults };
    const out: Record<string, unknown> = { ...defaults };
    for (const [k, v] of Object.entries(saved)) {
      if (k in defaults && fits(k as keyof Settings, v, defaults)) out[k] = v;
    }
    return out as unknown as Settings;
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(storage: Storage, s: Settings) {
  try {
    storage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private window or blocked storage: settings just aren't remembered
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd studio-ui && npx vitest run src/settings-store.test.ts 2>&1 | grep -E "Tests |FAIL"`
Expected: all passing.

- [ ] **Step 5: The page**

`index.html`, after `<p id="message" ...>`:

```html
    <p id="privacy" class="message" hidden>Your recordings stay in this browser and are never uploaded.</p>
```

and in the header after the take picker `<select id="takes">`:

```html
      <button id="delete-take" hidden title="Delete this take from the browser">Delete</button>
```

`main.ts` changes:
- Import `loadSettings, saveSettings` and `missingFeatures` (`import { missingFeatures } from "./web/support";`).
- Create the store from memory: `const store = createSettingsStore(loadSettings(localStorageOrNull(), DEFAULT_SETTINGS));` and add `store.subscribe((s) => saveSettings(localStorageOrNull(), s));`. Move `localStorageOrNull` above this line.
- Web-only chrome, near the top after `say`:

```ts
if (api.kind === "web") {
  $("privacy").hidden = false;
  const missing = missingFeatures();
  if (missing.length) {
    say(`This browser is missing ${missing.join(", ")}. Try a current Chrome, Edge, Firefox or Safari.`);
    for (const id of ["record", "takes"]) $<HTMLButtonElement>(id).disabled = true;
  }
}
```

- A progress callback used by all three open paths (upload after recording, Open WAV, picker):

```ts
const analyzing = (name: string) => (f: number) => say(`Analyzing ${name}... ${Math.round(f * 100)}%`);
```

and pass it: `api.uploadTake(takeName.value, wav, analyzing(takeName.value))`, `api.uploadTake(takeNameFromFile(f.name), await f.arrayBuffer(), analyzing(f.name))`, `api.openTake(name, analyzing(name))`.
- In `opened(r)`: after `say(...)`, add `document.body.dataset.analysis = r.cached ? "cached" : "fresh";` and `$("delete-take").hidden = !api.canDelete;`.
- Delete:

```ts
$("delete-take").addEventListener("click", async () => {
  const name = app.info?.name;
  if (!name || !confirm(`Delete ${name} from this browser?`)) return;
  await api.deleteTake(name);
  app.info = null;
  app.takeId = 0;
  app.notes = [];
  $("delete-take").hidden = true;
  say(`Deleted ${name}.`);
  await refreshTakes();
  redraw();
});
```

- Drag handles: in `updateDrag`, when `!api.canDragOut` show nothing: `if (!api.canDragOut) { drags.replaceChildren(); return; }` as the first line.
- Engine load failure (web): wrap the startup `api.currentTake()...` chain's `.catch` so a failed engine shows `say(\`${e.message}. \`)` plus a Retry button: `const retry = Object.assign(document.createElement("button"), { textContent: "Retry" }); retry.onclick = () => location.reload(); $("message").append(retry);`

`styles.css`: `#privacy { color: var(--ink-mut); }`

- [ ] **Step 6: Type-check, test, build both**

Run: `cd studio-ui && npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |FAIL" && npm run build 2>&1 | tail -1 && npm run build:web 2>&1 | tail -1`
Expected: tests all passing, `built in ...` twice.

- [ ] **Step 7: Commit**

```bash
git add studio-ui
git commit -m "Studio: analysis progress, delete, privacy line, remembered settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: End-to-end check of the built site in headless Chrome

**Files:**
- Create: `studio-ui/scripts/e2e-web.mjs`
- Modify: `studio-ui/package.json` (dev dependency `puppeteer-core@23`, script `e2e:web`)

**Interfaces:**
- Consumes: Task 5 `wav16`, `phrase`, `preview:web`; Task 10 `document.body.dataset.analysis`.

- [ ] **Step 1: Install and add the script**

Run: `cd studio-ui && npm i -D puppeteer-core@23`
Add to scripts: `"e2e:web": "node scripts/e2e-web.mjs"`.

- [ ] **Step 2: Write `studio-ui/scripts/e2e-web.mjs`**

```js
// Drive the built site (npm run build:web first) in headless Chrome:
// open a WAV, see notes, move a slider, save both files, reopen from cache.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { phrase, wav16 } from "./wav.mjs";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "voxmpe-e2e-"));
const wavPath = join(dir, "e2e phrase.wav");
writeFileSync(wavPath, wav16(phrase(44100), 44100));

const server = spawn("npx", ["vite", "preview", "--mode", "web", "--port", "4318", "--strictPort"], { stdio: "pipe" });
await new Promise((ok) => server.stdout.on("data", (d) => String(d).includes("4318") && ok()));
const fail = (msg) => { console.error(`e2e failed: ${msg}`); server.kill(); process.exit(1); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  await page.goto("http://localhost:4318/");

  const notes = () => page.$eval("#note-count", (e) => e.textContent);
  const waitNotes = () => page.waitForFunction(() => /\d+ notes/.test(document.getElementById("note-count").textContent) && !document.getElementById("note-count").textContent.startsWith("0 "), { timeout: 60000 });

  const input = await page.$("#wav-file");
  await input.uploadFile(wavPath);
  await waitNotes();
  if ((await page.evaluate(() => document.body.dataset.analysis)) !== "fresh") fail("first open should analyze");
  console.log("opened:", await notes());

  const flags = () => page.$eval("#controls code", (e) => e.textContent);
  const before = await flags();
  await page.$eval("#controls input[type=range]", (el) => { el.value = String(Number(el.value) + 50); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForFunction((b) => document.querySelector("#controls code").textContent !== b, { timeout: 10000 }, before);
  console.log("re-rendered:", await flags());

  await page.$$eval('input[name="format"]', (boxes) => boxes.forEach((b) => { if (!b.checked) b.click(); }));
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("saved-path").textContent.includes(".als"), { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1000));
  const saved = readdirSync(dir).filter((f) => f.endsWith(".mid") || f.endsWith(".als")).sort();
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
```

- [ ] **Step 3: Run it against the built site**

Run: `cd studio-ui && npm run build:web >/dev/null 2>&1 && npm run e2e:web`
Expected: `opened: N notes`, `re-rendered: --hold-ms 140`, `downloaded: e2e-phrase_studio.als, e2e-phrase_studio.mid`, `reopened from cache: e2e-phrase.wav`, `e2e ok`.

If a step fails, debug with superpowers:systematic-debugging; do not loosen the check.

- [ ] **Step 4: Commit**

```bash
git add studio-ui/package.json studio-ui/package-lock.json studio-ui/scripts/e2e-web.mjs
git commit -m "Studio web: end-to-end check in headless Chrome

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Deploy script (no deploy without Bengisu's go)

**Files:**
- Create: `scripts/deploy-web.sh`, `web/deploy/README.md`, `web/deploy/LICENSE`, `web/deploy/NOTICE`
- Modify: `README.md` (a "Browser studio" section)

**Interfaces:**
- Consumes: `npm run build:web` output `studio-ui/web-dist/`.
- Produces: `scripts/deploy-web.sh --stage DIR` (build and stage only) and `scripts/deploy-web.sh --push CHECKOUT` (stage into a clone of `swwallowws/voxmpe-web`, commit, push).

- [ ] **Step 1: Write the static files**

`web/deploy/README.md`:

```markdown
# voxmpe (browser)

Sing, get expressive MPE MIDI, in the browser: https://swwallowws.github.io/voxmpe-web/

This repository holds only the built site. Your recordings stay in your
browser and are never uploaded.
```

`web/deploy/LICENSE`:

```
voxmpe: Copyright (c) 2026 Bengisu Özaydın. All rights reserved.

This repository holds a built copy of voxmpe for use in the browser. Third-party
components and their licenses are listed in NOTICE.
```

`web/deploy/NOTICE`: the header below, then the dependency list the script appends.

```
Third-party components in this site

CREPE pitch model: Copyright (c) 2018 Jong Wook Kim et al., MIT License.
torchcrepe (model export): Copyright (c) 2020 Max Morrison, MIT License.

Rust crates compiled into voxmpe_web_bg.wasm (name version license):
```

- [ ] **Step 2: Write `scripts/deploy-web.sh`**

```bash
#!/usr/bin/env bash
# Build the browser studio and stage it for swwallowws/voxmpe-web.
#   scripts/deploy-web.sh --stage DIR       build and stage into DIR (no git)
#   scripts/deploy-web.sh --push CHECKOUT   stage into a clone of voxmpe-web, commit, push
# Pushing publishes the site: only with Bengisu's explicit go.
set -euo pipefail

mode="${1:-}"; target="${2:-}"
if [[ "$mode" != "--stage" && "$mode" != "--push" ]] || [[ -z "$target" ]]; then
  echo "usage: $0 --stage DIR | --push CHECKOUT" >&2; exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"

(cd "$root/studio-ui" && npm run build:web)

mkdir -p "$target"
find "$target" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$root/studio-ui/web-dist/." "$target/"
cp "$root/web/deploy/README.md" "$root/web/deploy/LICENSE" "$target/"
{
  cat "$root/web/deploy/NOTICE"
  (cd "$root" && cargo tree -p voxmpe-web --target wasm32-unknown-unknown -e normal --prefix none --format "{p} {l}" | sed 's/ (.*)//' | sort -u)
} > "$target/NOTICE"
touch "$target/.nojekyll"

if [[ "$mode" == "--push" ]]; then
  cd "$target"
  git add -A
  git commit -m "Deploy voxmpe $(git -C "$root" rev-parse --short HEAD)"
  git push
fi
echo "staged in $target"
```

Run: `chmod +x scripts/deploy-web.sh`

- [ ] **Step 3: Stage into the scratchpad and check the contents**

Run: `scripts/deploy-web.sh --stage <scratchpad>/voxmpe-web-stage && ls <scratchpad>/voxmpe-web-stage && grep -c . <scratchpad>/voxmpe-web-stage/NOTICE`
Expected: `index.html assets crepe-tiny.onnx README.md LICENSE NOTICE` (plus `.nojekyll`), and NOTICE with more than 20 lines, including `tract-onnx`.

- [ ] **Step 4: README section** (append to the root `README.md`)

```markdown
## Browser studio

The same studio, running entirely in the browser with CREPE tiny (2 MB): no
install, recordings kept in the browser.

    python scripts/export_crepe.py tiny     # once: models/crepe-tiny.onnx
    cd studio-ui && npm run build:web       # site in studio-ui/web-dist
    npm run preview:web                     # try it at http://localhost:4318
    npm run e2e:web                         # headless Chrome check

`scripts/deploy-web.sh --stage DIR` stages the site; `--push CHECKOUT` publishes
it to a clone of `swwallowws/voxmpe-web` (GitHub Pages).
```

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-web.sh web/deploy README.md
git commit -m "Deploy script for the browser studio (stages; pushes only on request)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Stop and ask Bengisu** whether to create the public repo `swwallowws/voxmpe-web`, enable Pages on it, and run `scripts/deploy-web.sh --push`. Also ask her to open the staged site in Safari (`npm run preview:web`, then http://localhost:4318) and say whether it works. Do nothing public until she says go.
