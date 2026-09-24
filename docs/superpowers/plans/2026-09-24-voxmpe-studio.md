# voxmpe studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge voxmidi-core and microtonal-voxmidi into one `voxmpe` workspace and build a local studio UI where you record or open a take, tune note segmentation by ear with instant re-render, and export an MPE `.mid` for Ableton.

**Architecture:** `voxmpe-core` (library) gains a two-stage API: slow `track()` once per take, millisecond `transcribe()` per settings change. The `voxmpe` app crate holds tuning (scala, quantize, retune), a `Settings` type shared by CLI and UI, a `Session` (no HTTP), a synchronous `tiny_http` server with a pure `handle()` function, and the `convert` / `studio` subcommands. `studio-ui/` is TypeScript + Vite, built into `crates/voxmpe/ui-dist/` and embedded with `include_dir`.

**Tech Stack:** Rust 1.98 (edition 2021), tract-onnx 0.21, midly 0.5, hound 3.5, clap 4, serde/serde_json 1, tiny_http 0.12, include_dir 0.7. Node 24, TypeScript 5.7, Vite 6, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-24-voxmpe-studio-design.md`

## Global Constraints

- Names: repo and app `voxmpe`, library crate `voxmpe-core` (Rust path `voxmpe_core`), binary `voxmpe`, app lib path `voxmpe`.
- No em dashes anywhere (code comments, UI copy, docs, commit messages).
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Work on branch `studio`; never push, rename, or archive anything on GitHub except in Task 16, and only after the user says go at that moment.
- Never use the microphone automatically. Anything touching the mic is the user's checkpoint (Task 15).
- `voxmpe-core` must not depend on UI, server, or tuning crates.
- Takes and exports live in `takes/` (gitignored). Nothing is written to the Desktop.
- `analyze()` output must stay identical to before the split.
- Server binds to `127.0.0.1` only.
- Design system (`~/Playground/design`, v0.1.0): sync it with `~/Playground/design/sync.sh studio-ui` into `studio-ui/vendor/design/` (committed). All colours, type and spacing come from its tokens; `<html data-category="transcribe">` selects voxmpe's accent. Follow `studio-ui/vendor/design/roll.md` for the piano roll: key bands, notes as tints of the accent (strength 35% + 65% * velocity), the sounding note full accent with a 1px ink outline, causes as note-start ticks (none after a gap, slanted tick for a pitch change, upright bar for a re-attack). No other colours; errors are shown in ink, never red.

## Review Focus

1. Take names with path parts or odd characters (`../x.wav`, `sub/x.wav`, `my take!`): opening is rejected with 400, uploads are sanitized and never overwrite or escape `takes/`. Tests in Task 6.
2. Browser recordings at 44.1, 48 or 96 kHz, mono or stereo, encoded as 32-bit float WAV with a 16-byte fmt chunk: the server must decode them. Test in Task 4 (exact browser byte layout) and Task 12 (encoder header).
3. Silent or very short takes: 0 notes, a quiet-take warning, and render/export still succeed with a valid MIDI file. Tests in Task 4.
4. Switching takes while a render is in flight: the server answers 409 to a stale `take_id`, and the UI drops out-of-order responses. Tests in Task 6 and Task 10.
5. An invalid `.scl` chosen in the picker: 400 with the parse message, and the UI keeps the last good tuning while keeping slider changes. Tests in Task 3, Task 6 and Task 10.

---

### Task 1: One workspace, renamed crates, both histories

**Files:**
- Move: `~/Playground/voxmidi-core/{src,tests,examples,Cargo.toml,README.md}` to `crates/voxmpe-core/`
- Merge: `~/Playground/microtonal-voxmidi` history into `crates/voxmpe/`
- Create: `Cargo.toml` (workspace root), `models/README.md`
- Modify: `.gitignore`, `crates/voxmpe-core/Cargo.toml`, `crates/voxmpe/Cargo.toml`, every `.rs` importing `voxmidi_core` or `microtonal`, model path constants in `crates/voxmpe-core/examples/common/mod.rs`, `crates/voxmpe-core/tests/{pitch_validation,segmentation}.rs`, `crates/voxmpe/src/main.rs`
- Rename folder: `~/Playground/voxmidi-core` to `~/Playground/voxmpe`

**Interfaces:**
- Produces: workspace with members `crates/voxmpe-core` (lib `voxmpe_core`) and `crates/voxmpe` (lib `voxmpe`, bin `voxmpe`); model at `<repo>/models/crepe-full.onnx`, referenced from crates as `concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-full.onnx")`.

- [ ] **Step 1: Branch and move the library**

```bash
cd ~/Playground/voxmidi-core
git checkout -b studio
mkdir -p crates/voxmpe-core
git mv src tests examples Cargo.toml README.md crates/voxmpe-core/
git commit -m "Move the library into crates/voxmpe-core

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Merge microtonal-voxmidi with its history**

```bash
git remote add microtonal ../microtonal-voxmidi
git fetch microtonal
git merge -s ours --no-commit --allow-unrelated-histories microtonal/main
git read-tree --prefix=crates/voxmpe/ -u microtonal/main
git commit -m "Merge microtonal-voxmidi history into crates/voxmpe

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git remote remove microtonal
git rm -q crates/voxmpe/Cargo.lock crates/voxmpe/.gitignore
```

Expected: `git log --oneline -- crates/voxmpe/src/scala.rs` shows `888ab14 Unified microtonal voice-to-MIDI app on voxmidi-core`.

- [ ] **Step 3: Workspace root manifest**

Create `Cargo.toml`:

```toml
[workspace]
members = ["crates/voxmpe-core", "crates/voxmpe"]
resolver = "2"

# Optimize dependencies (notably tract) even in dev/test builds so CREPE
# inference isn't unusably slow during development; our crates stay debug.
[profile.dev.package."*"]
opt-level = 3
```

- [ ] **Step 4: Rename the library crate**

In `crates/voxmpe-core/Cargo.toml`: set `name = "voxmpe-core"`, set `[lib] name = "voxmpe_core"`, and delete the `[profile.dev.package."*"]` block and its comment (the workspace root owns profiles now). Replace the description with:

```toml
description = "Singing voice to expressive MPE MIDI: CREPE pitch tracking, note segmentation, per-note bend and dynamics."
```

- [ ] **Step 5: Rewrite the app manifest**

Replace `crates/voxmpe/Cargo.toml` with:

```toml
[package]
name = "voxmpe"
version = "0.1.0"
edition = "2021"
description = "Sing, get expressive MPE MIDI: a studio for tuning note splits by ear, any Scala tuning, and a CLI."

[lib]
name = "voxmpe"
path = "src/lib.rs"

[[bin]]
name = "voxmpe"
path = "src/main.rs"

[dependencies]
voxmpe-core = { path = "../voxmpe-core" }
hound = "3.5"
anyhow = "1"
clap = { version = "4", features = ["derive"] }
```

- [ ] **Step 6: Rewrite imports and model paths**

```bash
grep -rl 'voxmidi_core' crates --include='*.rs' | xargs sed -i '' 's/voxmidi_core/voxmpe_core/g'
grep -rl 'microtonal::' crates/voxmpe --include='*.rs' | xargs sed -i '' 's/microtonal::/voxmpe::/g'
sed -i '' 's|"/models/crepe-full.onnx"|"/../../models/crepe-full.onnx"|' \
  crates/voxmpe-core/examples/common/mod.rs \
  crates/voxmpe-core/tests/pitch_validation.rs \
  crates/voxmpe-core/tests/segmentation.rs
```

In `crates/voxmpe/src/main.rs` replace the `DEFAULT_MODEL` line with:

```rust
/// CREPE model path (85 MB, gitignored; see models/README.md).
const DEFAULT_MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-full.onnx");
```

Then: `grep -rn 'voxmidi_core\|microtonal::\|voxmidi-core/models' crates` must print nothing.

- [ ] **Step 7: gitignore and model README**

Replace `.gitignore` with:

```gitignore
/target
# Model blobs are large (85 MB CREPE): downloaded or exported locally, never committed.
/models/*.onnx
# Voice takes and exports: personal recordings, never committed.
/takes
# Built studio UI, embedded at compile time.
/crates/voxmpe/ui-dist
.DS_Store
```

Create `models/README.md`:

```markdown
# CREPE model

voxmpe needs `crepe-full.onnx` (85 MB) in this folder.

Export it yourself (needs Python with torch, torchcrepe, onnxruntime):

    python scripts/export_crepe.py

It writes `models/crepe-full.onnx` and checks its pitch accuracy on test tones.

CREPE (Jong Wook Kim et al., 2018) and torchcrepe (Max Morrison, 2020) are MIT licensed.
```

- [ ] **Step 8: Build and run every test**

Run: `cargo test --workspace --release 2>&1 | grep -E 'test result|FAILED|error'`
Expected: every `test result: ok`, including core (primitives 12, segmentation 3, smf_header 2, pitch_validation 1) and the app's chord tests.

- [ ] **Step 9: Commit and rename the folder**

```bash
git add -A
git commit -m "Workspace: voxmpe-core library and voxmpe app

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
cd ~/Playground && mv voxmidi-core voxmpe && cd voxmpe && cargo test --workspace --release 2>&1 | grep -c 'test result: ok'
```

Expected: the same count of `test result: ok` lines as Step 8.

---

### Task 2: voxmpe-core two-stage API and in-memory MIDI

**Files:**
- Modify: `crates/voxmpe-core/src/lib.rs`, `crates/voxmpe-core/src/smf.rs`
- Test: `crates/voxmpe-core/tests/two_stage.rs`, `crates/voxmpe-core/tests/smf_header.rs`

**Interfaces:**
- Produces:
  - `pub struct Frames { pub frames: Vec<Frame>, pub hop_s: f32 }` (Debug, Clone)
  - `pub fn track(audio: &[f32], sample_rate: u32, model: &CrepeModel, cfg: &AnalysisConfig) -> anyhow::Result<Frames>`
  - `pub fn transcribe(frames: &Frames, cfg: &AnalysisConfig) -> Analysis`
  - `pub fn analyze(...)` unchanged signature, now `transcribe(&track(..)?, cfg)`
  - `pub fn smf::smf_bytes(analysis: &Analysis, mode: OutputMode) -> anyhow::Result<Vec<u8>>`

- [ ] **Step 1: Write the failing tests**

Create `crates/voxmpe-core/tests/two_stage.rs`:

```rust
//! The two-stage API: track() once, transcribe() per settings change, must match
//! a fresh analyze() exactly.

use voxmpe_core::{analyze, track, transcribe, AnalysisConfig, CrepeModel};

const MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-full.onnx");
const SR: u32 = 44_100;

fn load_model() -> Option<CrepeModel> {
    if !std::path::Path::new(MODEL).exists() {
        eprintln!("skipping: {MODEL} not found (see models/README.md)");
        return None;
    }
    Some(CrepeModel::from_path(MODEL).expect("model"))
}

/// A4 for 0.5 s, 0.2 s silence, then a C5 for 0.5 s, with harmonics.
fn phrase() -> Vec<f32> {
    let mut out = Vec::new();
    for (secs, hz) in [(0.5f32, 440.0f32), (0.2, 0.0), (0.5, 523.25)] {
        let n = (secs * SR as f32) as usize;
        for i in 0..n {
            let t = i as f32 / SR as f32;
            let env = (t / 0.02).min(1.0).min(((secs - t) / 0.05).max(0.0));
            let p = 2.0 * std::f32::consts::PI * hz * t;
            out.push(if hz > 0.0 { 0.3 * env * (p.sin() + 0.5 * (2.0 * p).sin()) } else { 0.0 });
        }
    }
    out
}

#[test]
fn two_stage_matches_analyze() {
    let Some(model) = load_model() else { return };
    let cfg = AnalysisConfig::default();
    let audio = phrase();
    let whole = analyze(&audio, SR, &model, &cfg).unwrap();
    let staged = transcribe(&track(&audio, SR, &model, &cfg).unwrap(), &cfg);
    assert_eq!(format!("{:?}", whole.notes), format!("{:?}", staged.notes));
    assert_eq!(whole.notes.len(), 2);
}

#[test]
fn retranscribe_with_new_settings_matches_fresh_analyze() {
    let Some(model) = load_model() else { return };
    let audio = phrase();
    let frames = track(&audio, SR, &model, &AnalysisConfig::default()).unwrap();
    let mut cfg = AnalysisConfig::default();
    cfg.segmentation.hold_time_ms = 300.0;
    cfg.segmentation.voicing_gap_ms = 300.0;
    let fresh = analyze(&audio, SR, &model, &cfg).unwrap();
    let again = transcribe(&frames, &cfg);
    assert_eq!(format!("{:?}", fresh.notes), format!("{:?}", again.notes));
}
```

Append to `crates/voxmpe-core/tests/smf_header.rs`:

```rust
#[test]
fn smf_bytes_match_the_written_file() {
    let path = std::env::temp_dir().join(format!("voxmpe_bytes_{}.mid", std::process::id()));
    write_smf(&one_note(), OutputMode::Mpe, path.to_str().unwrap()).unwrap();
    let from_file = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).ok();
    let bytes = voxmpe_core::smf::smf_bytes(&one_note(), OutputMode::Mpe).unwrap();
    assert_eq!(bytes, from_file);
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p voxmpe-core --release --test two_stage --test smf_header`
Expected: compile errors `cannot find function track`, `transcribe`, `smf_bytes`.

- [ ] **Step 3: Implement the split in `src/lib.rs`**

Replace `analyze` and add the new items (keep the module list and `pub use` lines, adding `SegmentationConfig` usage):

```rust
/// Output of the slow stage ([`track`]): every analysis frame plus the hop size.
/// Keep it to re-run [`transcribe`] with other settings without re-running CREPE.
#[derive(Debug, Clone)]
pub struct Frames {
    pub frames: Vec<Frame>,
    pub hop_s: f32,
}

/// Slow stage: CREPE pitch tracking + per-frame features, with the voicing gate
/// from `cfg` applied. Frames below `cfg.segmentation.rms_floor` skip inference.
pub fn track(
    audio: &[f32],
    sample_rate: u32,
    model: &CrepeModel,
    cfg: &AnalysisConfig,
) -> Result<Frames> {
    let raw = model.track_gated(audio, sample_rate, cfg.segmentation.rms_floor)?;
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
    Ok(Frames { frames, hop_s })
}

/// Fast stage: voicing gate, segmentation and expression for `cfg`. Milliseconds.
pub fn transcribe(frames: &Frames, cfg: &AnalysisConfig) -> Analysis {
    let sc = &cfg.segmentation;
    let hop_s = frames.hop_s;
    let mut frames = frames.frames.clone();
    apply_voicing(&mut frames, sc);

    let spans = segment::segment(&frames, hop_s, sc);
    let max_rms = frames.iter().map(|f| f.rms).fold(0.0f32, f32::max);
    let notes = spans
        .iter()
        .map(|&span| {
            // THE SEAM: keep the fractional center, derive the 12-TET note from it.
            let center = segment::span_pitch(&frames, span, sc);
            let pitch = segment::round_to_12tet(center);
            expression::encode_note(&frames, span, pitch, center, max_rms, hop_s, &cfg.expression)
        })
        .collect();

    Analysis { frames, notes, hop_s }
}

/// Full pipeline: [`track`] then [`transcribe`].
pub fn analyze(
    audio: &[f32],
    sample_rate: u32,
    model: &CrepeModel,
    cfg: &AnalysisConfig,
) -> Result<Analysis> {
    Ok(transcribe(&track(audio, sample_rate, model, cfg)?, cfg))
}

fn apply_voicing(frames: &mut [Frame], sc: &SegmentationConfig) {
    for f in frames {
        f.voiced = f.confidence >= sc.confidence_threshold && f.rms >= sc.rms_floor;
    }
}
```

- [ ] **Step 4: Implement `smf_bytes` in `src/smf.rs`**

Rename the body of `write_smf` into `smf_bytes`, ending with serialization to memory, and make `write_smf` a wrapper:

```rust
/// Serialize `analysis` as a Standard MIDI File in memory.
pub fn smf_bytes(analysis: &Analysis, mode: OutputMode) -> Result<Vec<u8>> {
    // ... unchanged event building, track assembly and `let smf = Smf { .. };` ...
    let mut buf = Vec::new();
    smf.write_std(&mut buf)?;
    Ok(buf)
}

pub fn write_smf(analysis: &Analysis, mode: OutputMode, path: &str) -> Result<()> {
    std::fs::write(path, smf_bytes(analysis, mode)?)?;
    Ok(())
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test -p voxmpe-core --release 2>&1 | grep -E '^test |test result'`
Expected: all pass, including `two_stage_matches_analyze`, `retranscribe_with_new_settings_matches_fresh_analyze`, `smf_bytes_match_the_written_file`.

- [ ] **Step 6: Lint and commit**

```bash
cargo fmt --all && cargo clippy --workspace --release --all-targets -- -D warnings
git add -A && git commit -m "Core: track() once, transcribe() per settings; smf_bytes()

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Settings shared by CLI and studio

**Files:**
- Create: `crates/voxmpe/src/settings.rs`, `crates/voxmpe/src/cli.rs`
- Modify: `crates/voxmpe/src/lib.rs` (add `pub mod settings; pub mod cli;`), `crates/voxmpe/Cargo.toml` (add `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`)
- Test: unit tests at the bottom of `crates/voxmpe/src/cli.rs`

**Interfaces:**
- Consumes: `voxmpe_core::{AnalysisConfig, SegmentationConfig}`, `voxmpe_core::smf::OutputMode`, `crate::scala::Scale::parse(&str) -> Result<Scale, String>`, `crate::quantize::Tuning::new(&Scale, f64)`.
- Produces:
  - `pub const MIDDLE_C_HZ: f64`, `pub const TET12_SCL: &str`
  - `pub struct Settings { hold_ms: f32, jump_hold_ms: f32, jump_cents: f32, gap_ms: f32, split_cents: f32, onset_delta: Option<f32>, tuning_name: Option<String>, tuning_scl: Option<String>, anchor_hz: f64, single_channel: Option<u8> }` (all `pub`; Debug, Clone, PartialEq, Serialize, Deserialize, `#[serde(default)]`)
  - `Settings::default()`, `Settings::legato()`, `analysis_config(&self) -> AnalysisConfig`, `tuning(&self) -> Result<Tuning, String>`, `output_mode(&self) -> OutputMode`, `to_flags(&self) -> String`
  - `pub struct SettingsArgs` (clap `Args`) with `to_settings(&self) -> anyhow::Result<Settings>`

- [ ] **Step 1: Write `settings.rs`**

```rust
//! Everything the user can adjust, shared by the studio UI and the CLI.

use serde::{Deserialize, Serialize};
use voxmpe_core::smf::OutputMode;
use voxmpe_core::{AnalysisConfig, SegmentationConfig};

use crate::quantize::Tuning;
use crate::scala::Scale;

/// 1/1 anchor default: middle C, which aligns a 12-TET scale to concert A440.
pub const MIDDLE_C_HZ: f64 = 261.625565;

/// Built-in 12-TET scale, used when no `.scl` is chosen.
pub const TET12_SCL: &str = "! 12-tet.scl
12 equal divisions of the octave
 12
 100.
 200.
 300.
 400.
 500.
 600.
 700.
 800.
 900.
 1000.
 1100.
 2/1
";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// How long a small pitch move must hold to start a note (ms).
    pub hold_ms: f32,
    /// How long a big jump (`jump_cents` or more) must hold (ms).
    pub jump_hold_ms: f32,
    pub jump_cents: f32,
    /// Silence (ms) that forces a new note.
    pub gap_ms: f32,
    /// Pitch move (cents) that can start a note.
    pub split_cents: f32,
    /// Loudness re-attack threshold (0.6 = +60%); `None` never splits on loudness.
    pub onset_delta: Option<f32>,
    /// Display name of the tuning (file name or path). `None` = 12-TET.
    pub tuning_name: Option<String>,
    /// Scala `.scl` text. `None` = 12-TET.
    pub tuning_scl: Option<String>,
    /// Frequency (Hz) of the scale's 1/1.
    pub anchor_hz: f64,
    /// `Some(range)`: single-channel MIDI with that bend range. `None`: MPE.
    pub single_channel: Option<u8>,
}

impl Default for Settings {
    fn default() -> Self {
        let s = SegmentationConfig::default();
        Self {
            hold_ms: s.hold_time_ms,
            jump_hold_ms: s.jump_hold_ms,
            jump_cents: s.jump_cents,
            gap_ms: s.voicing_gap_ms,
            split_cents: s.split_cents,
            onset_delta: Some(s.onset_rms_delta),
            tuning_name: None,
            tuning_scl: None,
            anchor_hz: MIDDLE_C_HZ,
            single_channel: None,
        }
    }
}

impl Settings {
    /// Preset for sung lyrics: bridge consonant gaps, hold longer, ignore loudness.
    pub fn legato() -> Self {
        Self {
            hold_ms: 180.0,
            gap_ms: 150.0,
            onset_delta: None,
            ..Self::default()
        }
    }

    pub fn analysis_config(&self) -> AnalysisConfig {
        let mut cfg = AnalysisConfig::default();
        let s = &mut cfg.segmentation;
        s.hold_time_ms = self.hold_ms;
        s.jump_hold_ms = self.jump_hold_ms;
        s.jump_cents = self.jump_cents;
        s.voicing_gap_ms = self.gap_ms;
        s.split_cents = self.split_cents;
        s.onset_rms_delta = self.onset_delta.unwrap_or(f32::INFINITY);
        cfg
    }

    pub fn tuning(&self) -> Result<Tuning, String> {
        let scale = Scale::parse(self.tuning_scl.as_deref().unwrap_or(TET12_SCL))?;
        Ok(Tuning::new(&scale, self.anchor_hz))
    }

    pub fn output_mode(&self) -> OutputMode {
        match self.single_channel {
            Some(bend_range) => OutputMode::SingleChannel { bend_range },
            None => OutputMode::Mpe,
        }
    }

    /// `voxmpe convert` flags that reproduce these settings (non-defaults only).
    pub fn to_flags(&self) -> String {
        let d = Settings::default();
        let mut f: Vec<String> = Vec::new();
        let mut num = |name: &str, v: f32, dv: f32| {
            if v != dv {
                f.push(format!("--{name} {v}"));
            }
        };
        num("hold-ms", self.hold_ms, d.hold_ms);
        num("jump-hold-ms", self.jump_hold_ms, d.jump_hold_ms);
        num("jump-cents", self.jump_cents, d.jump_cents);
        num("gap-ms", self.gap_ms, d.gap_ms);
        num("split-cents", self.split_cents, d.split_cents);
        match self.onset_delta {
            None => f.push("--no-onset".into()),
            Some(v) if Some(v) != d.onset_delta => f.push(format!("--onset-delta {v}")),
            Some(_) => {}
        }
        if let Some(n) = &self.tuning_name {
            if n.contains(char::is_whitespace) {
                f.push(format!("--tuning '{n}'"));
            } else {
                f.push(format!("--tuning {n}"));
            }
        }
        if self.anchor_hz != d.anchor_hz {
            f.push(format!("--anchor-hz {}", self.anchor_hz));
        }
        if let Some(r) = self.single_channel {
            f.push(format!("--single-channel {r}"));
        }
        f.join(" ")
    }
}
```

- [ ] **Step 2: Write `cli.rs` with failing tests**

```rust
//! Command-line flags that map onto [`Settings`]; the studio shows the same flags.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};

use crate::settings::Settings;

#[derive(clap::Args, Debug, Default)]
pub struct SettingsArgs {
    /// How long a small pitch move must hold to start a note (ms, default 90)
    #[arg(long)]
    pub hold_ms: Option<f32>,
    /// How long a big jump must hold (ms, default 90)
    #[arg(long)]
    pub jump_hold_ms: Option<f32>,
    /// Interval counted as a big jump (cents, default 300)
    #[arg(long)]
    pub jump_cents: Option<f32>,
    /// Silence that forces a new note (ms, default 80)
    #[arg(long)]
    pub gap_ms: Option<f32>,
    /// Pitch move that can start a note (cents, default 70)
    #[arg(long)]
    pub split_cents: Option<f32>,
    /// Loudness re-attack that starts a note (0.6 = +60%, default 0.6)
    #[arg(long, conflicts_with = "no_onset")]
    pub onset_delta: Option<f32>,
    /// Never split a note on loudness alone
    #[arg(long)]
    pub no_onset: bool,
    /// Start from the preset for sung lyrics (explicit flags still override)
    #[arg(long)]
    pub legato: bool,
    /// Scala .scl tuning file (omit for 12-TET)
    #[arg(long)]
    pub tuning: Option<PathBuf>,
    /// Frequency (Hz) of the scale's 1/1 (default middle C, 261.63)
    #[arg(long)]
    pub anchor_hz: Option<f64>,
    /// Single-channel MIDI with this bend range (semitones) instead of MPE
    #[arg(long)]
    pub single_channel: Option<u8>,
}

impl SettingsArgs {
    pub fn to_settings(&self) -> Result<Settings> {
        let mut s = if self.legato { Settings::legato() } else { Settings::default() };
        if let Some(v) = self.hold_ms { s.hold_ms = v; }
        if let Some(v) = self.jump_hold_ms { s.jump_hold_ms = v; }
        if let Some(v) = self.jump_cents { s.jump_cents = v; }
        if let Some(v) = self.gap_ms { s.gap_ms = v; }
        if let Some(v) = self.split_cents { s.split_cents = v; }
        if self.no_onset {
            s.onset_delta = None;
        } else if let Some(v) = self.onset_delta {
            s.onset_delta = Some(v);
        }
        if let Some(p) = &self.tuning {
            let text = std::fs::read_to_string(p)
                .with_context(|| format!("reading tuning {}", p.display()))?;
            s.tuning_scl = Some(text);
            s.tuning_name = Some(p.display().to_string());
        }
        if let Some(v) = self.anchor_hz { s.anchor_hz = v; }
        s.single_channel = self.single_channel;
        s.tuning().map_err(|e| anyhow!("parsing tuning: {e}"))?;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use voxmpe_core::AnalysisConfig;

    #[derive(Parser)]
    struct T {
        #[command(flatten)]
        a: SettingsArgs,
    }

    fn parse(flags: &str) -> Settings {
        let args = std::iter::once("t").chain(flags.split_whitespace());
        T::try_parse_from(args).unwrap().a.to_settings().unwrap()
    }

    #[test]
    fn defaults_match_the_core() {
        assert_eq!(
            format!("{:?}", Settings::default().analysis_config()),
            format!("{:?}", AnalysisConfig::default())
        );
        assert_eq!(Settings::default().to_flags(), "");
    }

    #[test]
    fn legato_preset() {
        let l = Settings::legato();
        assert_eq!((l.hold_ms, l.gap_ms, l.onset_delta), (180.0, 150.0, None));
        assert_eq!(l.analysis_config().segmentation.onset_rms_delta, f32::INFINITY);
        assert_eq!(parse("--legato"), l);
    }

    #[test]
    fn flags_round_trip() {
        let scl = std::env::temp_dir().join(format!("voxmpe_rt_{}.scl", std::process::id()));
        std::fs::write(&scl, "! t\n5-EDO\n 5\n 240.\n 480.\n 720.\n 960.\n 2/1\n").unwrap();
        let cases = [
            Settings::legato(),
            Settings { hold_ms: 150.0, jump_hold_ms: 50.0, split_cents: 90.0, ..Settings::default() },
            Settings { onset_delta: Some(1.2), anchor_hz: 440.0, single_channel: Some(2), ..Settings::default() },
            Settings {
                tuning_name: Some(scl.display().to_string()),
                tuning_scl: Some(std::fs::read_to_string(&scl).unwrap()),
                ..Settings::default()
            },
        ];
        for s in cases {
            assert_eq!(parse(&s.to_flags()), s, "flags: {}", s.to_flags());
        }
        std::fs::remove_file(scl).ok();
    }

    #[test]
    fn invalid_scl_is_an_error() {
        let s = Settings { tuning_scl: Some("not a scale".into()), ..Settings::default() };
        assert!(s.tuning().is_err());
    }
}
```

Add to `crates/voxmpe/src/lib.rs`: `pub mod cli;` and `pub mod settings;`.

- [ ] **Step 3: Run the tests**

Run: `cargo test -p voxmpe --release --lib cli`
Expected: 4 passed.

- [ ] **Step 4: Lint and commit**

```bash
cargo fmt --all && cargo clippy --workspace --release --all-targets -- -D warnings
git add -A && git commit -m "Settings shared by CLI and studio, with flags round trip

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: WAV decoding and the Session

**Files:**
- Create: `crates/voxmpe/src/audio.rs`, `crates/voxmpe/src/model.rs`, `crates/voxmpe/src/session.rs`
- Modify: `crates/voxmpe/src/lib.rs` (add `pub mod audio; pub mod model; pub mod session;`), `crates/voxmpe/Cargo.toml` (dev-dependency `midly = "0.5"`)
- Test: unit tests in `audio.rs`; `crates/voxmpe/tests/session.rs`

**Interfaces:**
- Consumes: `voxmpe_core::{track, transcribe, Frames, CrepeModel, AnalysisConfig}`, `voxmpe_core::segment::{segment, Cause}`, `voxmpe_core::smf::smf_bytes`, `crate::retune::retune`, `crate::settings::Settings`.
- Produces:
  - `audio::decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32)>`, `audio::peak(&[f32]) -> f32`
  - `model::DEFAULT_MODEL: &str`, `model::load_model(path: Option<&Path>) -> Result<CrepeModel>` (order: `path`, then env `VOXMPE_MODEL`, then `DEFAULT_MODEL`; missing file error mentions `models/README.md`)
  - `session::Session::load(name: &str, wav: Vec<u8>, model: &CrepeModel) -> Result<Session>`; fields `pub name: String`, `pub wav: Vec<u8>`
  - `Session::info(&self) -> TakeInfo`, `render(&self, &Settings) -> Result<Rendered>`, `export_mid(&self, &Settings) -> Result<Vec<u8>>`
  - `TakeInfo { name: String, duration_s: f32, hop_s: f32, contour: Vec<Option<f32>>, loudness: Vec<f32>, warning: Option<String> }` (Serialize)
  - `RNote { pitch: u8, center: f64, start: f32, end: f32, velocity: f32, cause: &'static str, bend: Vec<[f32; 2]>, amp: Vec<[f32; 2]> }` (Serialize); `cause` is `"gap"`, `"pitch"` or `"reattack"`
  - `Rendered { notes: Vec<RNote>, flags: String }` (Serialize)

- [ ] **Step 1: `audio.rs` with tests (including the browser's exact WAV layout)**

```rust
//! WAV decoding for takes: files on disk and browser uploads.

use std::io::Cursor;

use anyhow::{Context, Result};

/// Decode WAV bytes to mono f32 + sample rate (multichannel is downmixed).
pub fn decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::new(Cursor::new(bytes)).context("not a readable WAV file")?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<_, _>>()?
        }
    };
    let mono = if channels == 1 {
        samples
    } else {
        samples.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect()
    };
    Ok((mono, spec.sample_rate))
}

/// Largest absolute sample value.
pub fn peak(audio: &[f32]) -> f32 {
    audio.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hound_wav(spec: hound::WavSpec, write: impl Fn(&mut hound::WavWriter<&mut Cursor<Vec<u8>>>)) -> Vec<u8> {
        let mut cur = Cursor::new(Vec::new());
        {
            let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
            write(&mut w);
            w.finalize().unwrap();
        }
        cur.into_inner()
    }

    #[test]
    fn stereo_int16_is_downmixed() {
        let spec = hound::WavSpec { channels: 2, sample_rate: 48_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let bytes = hound_wav(spec, |w| {
            w.write_sample(16384i16).unwrap();
            w.write_sample(0i16).unwrap();
        });
        let (mono, sr) = decode_wav(&bytes).unwrap();
        assert_eq!(sr, 48_000);
        assert_eq!(mono.len(), 1);
        assert!((mono[0] - 0.25).abs() < 1e-4);
    }

    /// Exactly what studio-ui/src/wav.ts writes: RIFF, 16-byte fmt chunk,
    /// format 3 (IEEE float), mono, 32-bit, then the data chunk.
    #[test]
    fn decodes_the_browser_float_wav_layout() {
        let samples = [0.5f32, -0.25, 0.0];
        let sr = 96_000u32;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + samples.len() as u32 * 4).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&3u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&(sr * 4).to_le_bytes());
        b.extend_from_slice(&4u16.to_le_bytes());
        b.extend_from_slice(&32u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(samples.len() as u32 * 4).to_le_bytes());
        for s in samples {
            b.extend_from_slice(&s.to_le_bytes());
        }
        let (mono, got_sr) = decode_wav(&b).unwrap();
        assert_eq!(got_sr, sr);
        assert_eq!(mono, samples);
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(decode_wav(b"definitely not audio").is_err());
    }
}
```

Run: `cargo test -p voxmpe --release --lib audio`. Expected: 3 passed. If `decodes_the_browser_float_wav_layout` fails because hound rejects a 16-byte fmt chunk for format 3, change the browser encoder contract instead: write an 18-byte fmt chunk (append `cbSize = 0` as u16, fmt size 18, RIFF size +2, data offset 46) in this test and in Task 12's `encodeWavFloat32`, and note it in both files.

- [ ] **Step 2: `model.rs`**

```rust
//! Locating and loading the CREPE model.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use voxmpe_core::CrepeModel;

/// Where the model lives in a repo checkout (see models/README.md).
pub const DEFAULT_MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-full.onnx");

/// Load CREPE from `path`, else `$VOXMPE_MODEL`, else [`DEFAULT_MODEL`].
pub fn load_model(path: Option<&Path>) -> Result<CrepeModel> {
    let p: PathBuf = match path {
        Some(p) => p.to_path_buf(),
        None => std::env::var_os("VOXMPE_MODEL").map(PathBuf::from).unwrap_or_else(|| DEFAULT_MODEL.into()),
    };
    if !p.exists() {
        bail!("CREPE model not found at {}. See models/README.md for how to get it.", p.display());
    }
    CrepeModel::from_path(&p.to_string_lossy()).with_context(|| format!("loading {}", p.display()))
}
```

- [ ] **Step 3: Write the failing Session tests**

Create `crates/voxmpe/tests/session.rs`:

```rust
use std::io::Cursor;

use midly::{MidiMessage, Smf, TrackEventKind};
use voxmpe::session::Session;
use voxmpe::settings::Settings;
use voxmpe_core::CrepeModel;

const SR: u32 = 44_100;

fn model() -> Option<CrepeModel> {
    if !std::path::Path::new(voxmpe::model::DEFAULT_MODEL).exists() {
        eprintln!("skipping: model not found (see models/README.md)");
        return None;
    }
    Some(voxmpe::model::load_model(None).unwrap())
}

fn wav(samples: &[f32]) -> Vec<u8> {
    let spec = hound::WavSpec { channels: 1, sample_rate: SR, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for &s in samples {
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    }
    cur.into_inner()
}

/// A4 for 0.5 s then C5 for 0.5 s, joined with no gap (a 300-cent step), at `amp`.
fn step(amp: f32) -> Vec<f32> {
    let n = SR as usize;
    let mut phase = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / SR as f32;
            let hz = if t < 0.5 { 440.0 } else { 523.25 };
            phase += 2.0 * std::f32::consts::PI * hz / SR as f32;
            let env = (t / 0.02).min(1.0).min(((1.0 - t) / 0.05).max(0.0));
            amp * env * (phase.sin() + 0.5 * (2.0 * phase).sin())
        })
        .collect()
}

fn note_ons(mid: &[u8]) -> usize {
    let smf = Smf::parse(mid).unwrap();
    smf.tracks[0]
        .iter()
        .filter(|e| matches!(e.kind, TrackEventKind::Midi { message: MidiMessage::NoteOn { .. }, .. }))
        .count()
}

#[test]
fn render_responds_to_settings_without_retracking() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let default = s.render(&Settings::default()).unwrap();
    let pitches: Vec<u8> = default.notes.iter().map(|n| n.pitch).collect();
    assert_eq!(pitches, vec![69, 72]);
    assert_eq!(default.notes[1].cause, "pitch");
    let wide = s.render(&Settings { split_cents: 400.0, ..Settings::default() }).unwrap();
    assert_eq!(wide.notes.len(), 1, "a 300c step must not split at 400c");
    assert_eq!(wide.flags, "--split-cents 400");
}

#[test]
fn export_is_a_valid_mpe_file_with_every_note() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let mid = s.export_mid(&Settings::default()).unwrap();
    assert_eq!(note_ons(&mid), 2);
}

#[test]
fn silent_take_warns_and_still_exports() {
    let Some(m) = model() else { return };
    let s = Session::load("quiet", wav(&step(0.001)), &m).unwrap();
    assert!(s.info().warning.is_some());
    let r = s.render(&Settings::default()).unwrap();
    assert!(r.notes.is_empty());
    assert_eq!(note_ons(&s.export_mid(&Settings::default()).unwrap()), 0);
}

#[test]
fn very_short_take_is_fine() {
    let Some(m) = model() else { return };
    let s = Session::load("short", wav(&step(0.3)[..SR as usize / 20]), &m).unwrap();
    assert!(s.render(&Settings::default()).is_ok());
}

#[test]
fn bad_tuning_is_an_error_not_a_panic() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let bad = Settings { tuning_scl: Some("not a scale".into()), ..Settings::default() };
    assert!(s.render(&bad).is_err());
}

#[test]
fn info_has_one_contour_point_per_frame() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let info = s.info();
    assert_eq!(info.contour.len(), info.loudness.len());
    assert!((info.duration_s - 1.0).abs() < 0.01);
    assert!(info.loudness.iter().all(|&l| (0.0..=1.0).contains(&l)));
}
```

Run: `cargo test -p voxmpe --release --test session`. Expected: compile error, `session` module not found.

- [ ] **Step 4: Implement `session.rs`**

```rust
//! One loaded take: decoded once, CREPE-tracked once, re-rendered per settings.

use anyhow::{anyhow, Result};
use serde::Serialize;
use voxmpe_core::segment::{self, Cause};
use voxmpe_core::smf::smf_bytes;
use voxmpe_core::types::Analysis;
use voxmpe_core::{track, transcribe, AnalysisConfig, CrepeModel, Frames};

use crate::audio::{decode_wav, peak};
use crate::retune::retune;
use crate::settings::Settings;

/// Below this peak level a take is probably the wrong mic or muted.
const QUIET_PEAK: f32 = 0.01;
/// CREPE confidence at which the raw contour is drawn.
const CONTOUR_CONFIDENCE: f32 = 0.5;

pub struct Session {
    pub name: String,
    pub wav: Vec<u8>,
    duration_s: f32,
    frames: Frames,
    warning: Option<String>,
}

#[derive(Serialize)]
pub struct TakeInfo {
    pub name: String,
    pub duration_s: f32,
    pub hop_s: f32,
    /// Raw sung pitch per frame (fractional MIDI note), `None` where unvoiced.
    pub contour: Vec<Option<f32>>,
    /// Per-frame loudness, normalized to 0..1.
    pub loudness: Vec<f32>,
    pub warning: Option<String>,
}

#[derive(Serialize)]
pub struct RNote {
    pub pitch: u8,
    pub center: f64,
    pub start: f32,
    pub end: f32,
    pub velocity: f32,
    pub cause: &'static str,
    /// `[time_s, semitones relative to pitch]`
    pub bend: Vec<[f32; 2]>,
    /// `[time_s, 0..1]`
    pub amp: Vec<[f32; 2]>,
}

#[derive(Serialize)]
pub struct Rendered {
    pub notes: Vec<RNote>,
    pub flags: String,
}

impl Session {
    pub fn load(name: &str, wav: Vec<u8>, model: &CrepeModel) -> Result<Session> {
        let (audio, sr) = decode_wav(&wav)?;
        let frames = track(&audio, sr, model, &AnalysisConfig::default())?;
        let warning = (peak(&audio) < QUIET_PEAK).then(|| {
            "Very quiet take: check that the right mic is selected and its level is up.".to_string()
        });
        Ok(Session {
            name: name.to_string(),
            wav,
            duration_s: audio.len() as f32 / sr as f32,
            frames,
            warning,
        })
    }

    pub fn info(&self) -> TakeInfo {
        let max = self.frames.frames.iter().map(|f| f.rms).fold(0.0f32, f32::max);
        TakeInfo {
            name: self.name.clone(),
            duration_s: self.duration_s,
            hop_s: self.frames.hop_s,
            contour: self
                .frames
                .frames
                .iter()
                .map(|f| (f.confidence >= CONTOUR_CONFIDENCE && f.f0_hz > 0.0).then(|| segment::hz_to_semitones(f.f0_hz)))
                .collect(),
            loudness: self
                .frames
                .frames
                .iter()
                .map(|f| if max > 0.0 { (f.rms / max).clamp(0.0, 1.0) } else { 0.0 })
                .collect(),
            warning: self.warning.clone(),
        }
    }

    pub fn render(&self, s: &Settings) -> Result<Rendered> {
        let analysis = self.analysis(s)?;
        let spans = segment::segment(&analysis.frames, analysis.hop_s, &s.analysis_config().segmentation);
        let notes = analysis
            .notes
            .iter()
            .zip(&spans)
            .map(|(n, span)| RNote {
                pitch: n.pitch,
                center: n.pitch_center,
                start: n.start,
                end: n.end,
                velocity: n.velocity,
                cause: match span.cause {
                    Cause::Voicing => "gap",
                    Cause::PitchChange => "pitch",
                    Cause::Reattack => "reattack",
                },
                bend: n.bend.iter().map(|p| [p.time, p.value]).collect(),
                amp: n.amplitude.iter().map(|p| [p.time, p.value]).collect(),
            })
            .collect();
        Ok(Rendered { notes, flags: s.to_flags() })
    }

    pub fn export_mid(&self, s: &Settings) -> Result<Vec<u8>> {
        smf_bytes(&self.analysis(s)?, s.output_mode())
    }

    fn analysis(&self, s: &Settings) -> Result<Analysis> {
        let tuning = s.tuning().map_err(|e| anyhow!("tuning: {e}"))?;
        Ok(retune(&transcribe(&self.frames, &s.analysis_config()), &tuning))
    }
}
```

If `voxmpe_core::Frames` is not re-exported at the crate root, it is (Task 2 defines it in `lib.rs`). If `segment::hz_to_semitones` is not `pub`, it is (it is `pub fn` in `segment.rs`).

- [ ] **Step 5: Run the tests**

Run: `cargo test -p voxmpe --release --test session --lib`
Expected: all pass.

- [ ] **Step 6: Lint and commit**

```bash
cargo fmt --all && cargo clippy --workspace --release --all-targets -- -D warnings
git add -A && git commit -m "Session: decode and track a take once, render and export per settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `voxmpe convert`

**Files:**
- Modify: `crates/voxmpe/src/main.rs` (rewrite)
- Test: `crates/voxmpe/tests/cli.rs`

**Interfaces:**
- Consumes: `voxmpe::cli::SettingsArgs`, `voxmpe::model::load_model`, `voxmpe::session::Session`.
- Produces: binary `voxmpe` with subcommand `convert <INPUT> [-o OUTPUT] [--model PATH] [settings flags]`. Task 7 adds `studio` to the same `Cmd` enum.

- [ ] **Step 1: Write the failing CLI tests**

```rust
use std::io::Cursor;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_voxmpe");

#[test]
fn help_lists_convert() {
    let out = Command::new(BIN).arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("convert"));
}

#[test]
fn missing_model_points_to_the_readme() {
    let out = Command::new(BIN)
        .args(["convert", "in.wav", "--model", "/nonexistent/crepe.onnx"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("models/README.md"));
}

#[test]
fn convert_writes_a_midi_file() {
    if !std::path::Path::new(voxmpe::model::DEFAULT_MODEL).exists() {
        eprintln!("skipping: model not found");
        return;
    }
    let dir = std::env::temp_dir().join(format!("voxmpe_cli_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("in.wav");
    let output = dir.join("out.mid");
    let spec = hound::WavSpec { channels: 1, sample_rate: 44_100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for i in 0..44_100 {
            let t = i as f32 / 44_100.0;
            w.write_sample((0.3 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }
    std::fs::write(&input, cur.into_inner()).unwrap();
    let st = Command::new(BIN)
        .args(["convert", input.to_str().unwrap(), "-o", output.to_str().unwrap(), "--legato"])
        .status()
        .unwrap();
    assert!(st.success());
    assert!(midly::Smf::parse(&std::fs::read(&output).unwrap()).is_ok());
    std::fs::remove_dir_all(dir).ok();
}
```

Run: `cargo test -p voxmpe --release --test cli`. Expected: `help_lists_convert` and `missing_model_points_to_the_readme` fail (old CLI).

- [ ] **Step 2: Rewrite `main.rs`**

```rust
//! voxmpe: sing, get expressive MPE MIDI. `convert` for batch work; `studio`
//! (Task 7) for tuning by ear.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use voxmpe::cli::SettingsArgs;
use voxmpe::session::Session;

#[derive(Parser)]
#[command(name = "voxmpe", about = "Sing, get expressive MPE MIDI")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Convert a WAV recording to a MIDI file
    Convert {
        /// Input WAV (mono or stereo, any sample rate)
        input: PathBuf,
        /// Output MIDI path
        #[arg(short, long, default_value = "out.mid")]
        output: PathBuf,
        /// CREPE model path (default: models/crepe-full.onnx or $VOXMPE_MODEL)
        #[arg(long)]
        model: Option<PathBuf>,
        #[command(flatten)]
        settings: SettingsArgs,
    },
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Convert { input, output, model, settings } => convert(input, output, model, settings),
    }
}

fn convert(input: PathBuf, output: PathBuf, model: Option<PathBuf>, args: SettingsArgs) -> Result<()> {
    let settings = args.to_settings()?;
    let model = voxmpe::model::load_model(model.as_deref())?;
    let wav = std::fs::read(&input).with_context(|| format!("reading {}", input.display()))?;
    let name = input.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let session = Session::load(&name, wav, &model)?;
    if let Some(w) = &session.info().warning {
        eprintln!("warning: {w}");
    }
    let rendered = session.render(&settings)?;
    for n in &rendered.notes {
        eprintln!("  {:7.2}-{:7.2} s  note {:>3}  {}", n.start, n.end, n.pitch, n.cause);
    }
    std::fs::write(&output, session.export_mid(&settings)?)
        .with_context(|| format!("writing {}", output.display()))?;
    eprintln!("{} notes -> {}", rendered.notes.len(), output.display());
    Ok(())
}
```

Delete the old `read_wav`, `TET12_SCL`, `MIDDLE_C_HZ` and `DEFAULT_MODEL` from `main.rs` (they now live in `audio.rs`, `settings.rs` and `model.rs`).

- [ ] **Step 3: Run, lint, commit**

Run: `cargo test -p voxmpe --release --test cli`. Expected: 3 passed.

```bash
cargo fmt --all && cargo clippy --workspace --release --all-targets -- -D warnings
git add -A && git commit -m "voxmpe convert: thin CLI on the shared Session and Settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: HTTP server with a pure request handler

**Files:**
- Create: `crates/voxmpe/src/server.rs`, `crates/voxmpe/build.rs`
- Modify: `crates/voxmpe/src/lib.rs` (add `pub mod server;`), `crates/voxmpe/Cargo.toml` (add `tiny_http = "0.12"`, `include_dir = "0.7"`)
- Test: `crates/voxmpe/tests/server.rs`

**Interfaces:**
- Consumes: `Session::{load, info, render, export_mid}`, `Settings`.
- Produces:
  - `pub struct State { pub model: Option<CrepeModel>, pub takes_dir: PathBuf, pub session: Option<Session>, pub take_id: u64, pub last_export: Option<PathBuf> }` with `State::new(model: Option<CrepeModel>, takes_dir: PathBuf) -> State` and `State::preload(&mut self, path: &Path) -> Result<()>`
  - `pub struct Reply { pub status: u16, pub content_type: &'static str, pub body: Vec<u8>, pub headers: Vec<(&'static str, String)> }`
  - `pub fn handle(state: &mut State, method: &str, url: &str, body: &[u8]) -> Reply`
  - `pub fn bind(start_port: u16) -> Result<(tiny_http::Server, u16)>` (tries 20 ports)
  - `pub fn serve(server: &tiny_http::Server, state: &mut State)`
  - Routes (JSON unless noted): `GET /` and static files; `GET /api/takes` -> `["a.wav", ...]`; `POST /api/load?name=X.wav` (empty body: open from takes; WAV body: save as sanitized unique `X.wav` then open) -> `{ "take_id": u64, "info": TakeInfo }`; `POST /api/render` body `{ "take_id", "settings" }` -> `Rendered`; `GET /api/audio` -> `audio/wav`; `POST /api/export` body `{ "take_id", "settings" }` -> `{ "path": String, "file_name": String }`; `GET /api/exported.mid` -> `audio/midi`; `POST /api/reveal` -> `{}`. Errors: `{ "error": String }` with 400 (bad input or tuning), 404, 409 (no take or stale `take_id`), 500 (model missing or analysis failed).

- [ ] **Step 1: `build.rs` so the crate compiles before the UI is built**

```rust
//! Ensure ui-dist/ exists so include_dir! compiles before `npm run build`.
use std::{fs, path::Path};

const FALLBACK: &str = "<!doctype html><meta charset=utf-8><title>voxmpe</title>\
<p>The studio UI is not built yet. Run <code>npm install &amp;&amp; npm run build</code> \
in <code>studio-ui/</code>, then rebuild voxmpe.</p>";

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("ui-dist");
    if !dir.join("index.html").exists() {
        fs::create_dir_all(&dir).expect("create ui-dist");
        fs::write(dir.join("index.html"), FALLBACK).expect("write fallback index.html");
    }
    println!("cargo:rerun-if-changed=ui-dist");
}
```

- [ ] **Step 2: Write the failing server tests**

Create `crates/voxmpe/tests/server.rs`:

```rust
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;

use voxmpe::server::{self, handle, State};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("voxmpe_srv_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn model() -> Option<voxmpe_core::CrepeModel> {
    std::path::Path::new(voxmpe::model::DEFAULT_MODEL)
        .exists()
        .then(|| voxmpe::model::load_model(None).unwrap())
}

fn wav(secs: f32, amp: f32) -> Vec<u8> {
    let spec = hound::WavSpec { channels: 1, sample_rate: 44_100, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for i in 0..(secs * 44_100.0) as usize {
            let t = i as f32 / 44_100.0;
            w.write_sample(amp * (2.0 * std::f32::consts::PI * 440.0 * t).sin()).unwrap();
        }
        w.finalize().unwrap();
    }
    cur.into_inner()
}

fn json(r: &server::Reply) -> serde_json::Value {
    serde_json::from_slice(&r.body).unwrap()
}

#[test]
fn serves_the_ui_and_404s_unknown_paths() {
    let mut st = State::new(None, temp_dir("ui"));
    let r = handle(&mut st, "GET", "/", b"");
    assert_eq!((r.status, r.content_type), (200, "text/html; charset=utf-8"));
    assert_eq!(handle(&mut st, "GET", "/nope", b"").status, 404);
}

#[test]
fn takes_lists_only_wavs() {
    let dir = temp_dir("list");
    std::fs::create_dir_all(&dir).unwrap();
    for f in ["b.wav", "a.wav", "notes.txt", "a_studio.mid"] {
        std::fs::write(dir.join(f), b"x").unwrap();
    }
    let mut st = State::new(None, dir);
    let r = handle(&mut st, "GET", "/api/takes", b"");
    assert_eq!(json(&r), serde_json::json!(["a.wav", "b.wav"]));
}

#[test]
fn opening_rejects_path_parts() {
    let dir = temp_dir("trav");
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = State::new(None, dir);
    for name in ["../secret.wav", "sub/x.wav", "%2E%2E%2Fsecret.wav", ".hidden.wav", "x.txt"] {
        let r = handle(&mut st, "POST", &format!("/api/load?name={name}"), b"");
        assert_eq!(r.status, 400, "{name}");
    }
}

#[test]
fn uploads_are_sanitized_unique_and_saved_before_analysis() {
    let dir = temp_dir("up");
    let mut st = State::new(None, dir.clone());
    let a = handle(&mut st, "POST", "/api/load?name=my%20take!", &wav(0.1, 0.3));
    let b = handle(&mut st, "POST", "/api/load?name=my%20take!", &wav(0.1, 0.3));
    // No model: analysis fails with 500, but the recording is kept.
    assert_eq!((a.status, b.status), (500, 500));
    assert!(dir.join("my-take.wav").exists());
    assert!(dir.join("my-take-2.wav").exists());
    let c = handle(&mut st, "POST", "/api/load?name=..%2F..%2Fevil", &wav(0.1, 0.3));
    assert_eq!(c.status, 500);
    assert!(dir.join("evil.wav").exists(), "path parts are stripped, file stays in takes/");
}

#[test]
fn render_needs_the_current_take() {
    let mut st = State::new(None, temp_dir("409"));
    let body = serde_json::json!({ "take_id": 1, "settings": {} }).to_string();
    assert_eq!(handle(&mut st, "POST", "/api/render", body.as_bytes()).status, 409);
}

#[test]
fn full_flow_with_the_model() {
    let Some(m) = model() else { eprintln!("skipping: model not found"); return };
    let dir = temp_dir("flow").join("missing-subdir");
    let mut st = State::new(Some(m), dir.clone());
    let r = handle(&mut st, "POST", "/api/load?name=tone", &wav(1.0, 0.3));
    assert_eq!(r.status, 200);
    let id = json(&r)["take_id"].as_u64().unwrap();

    let stale = serde_json::json!({ "take_id": id + 1, "settings": {} }).to_string();
    assert_eq!(handle(&mut st, "POST", "/api/render", stale.as_bytes()).status, 409);

    let bad = serde_json::json!({ "take_id": id, "settings": { "tuning_scl": "not a scale" } }).to_string();
    let r = handle(&mut st, "POST", "/api/render", bad.as_bytes());
    assert_eq!(r.status, 400);
    assert!(json(&r)["error"].as_str().unwrap().contains("tuning"));

    let ok = serde_json::json!({ "take_id": id, "settings": { "hold_ms": 150.0 } }).to_string();
    let r = handle(&mut st, "POST", "/api/render", ok.as_bytes());
    assert_eq!(r.status, 200);
    assert_eq!(json(&r)["flags"], "--hold-ms 150");

    let r = handle(&mut st, "POST", "/api/export", ok.as_bytes());
    assert_eq!(r.status, 200);
    assert!(dir.join("tone_studio.mid").exists(), "export creates takes/ if missing");
    let served = handle(&mut st, "GET", "/api/exported.mid", b"");
    assert_eq!(served.body, std::fs::read(dir.join("tone_studio.mid")).unwrap());

    assert_eq!(handle(&mut st, "GET", "/api/audio", b"").content_type, "audio/wav");
}

#[test]
fn bind_skips_a_busy_port() {
    let busy = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = busy.local_addr().unwrap().port();
    let (_server, got) = server::bind(port).unwrap();
    assert!(got > port);
}

#[test]
fn answers_over_real_http() {
    let (srv, port) = server::bind(0).unwrap_or_else(|_| server::bind(47000).unwrap());
    let dir = temp_dir("http");
    std::thread::spawn(move || {
        let mut st = State::new(None, dir);
        server::serve(&srv, &mut st);
    });
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(b"GET /api/takes HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.ends_with("[]"), "{out}");
}
```

Run: `cargo test -p voxmpe --release --test server`. Expected: compile error, `server` module not found.

- [ ] **Step 3: Implement `server.rs`**

```rust
//! The studio's local server: a pure `handle()` plus a thin tiny_http loop.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use include_dir::{include_dir, Dir};
use serde::Deserialize;
use voxmpe_core::CrepeModel;

use crate::session::Session;
use crate::settings::Settings;

static UI: Dir = include_dir!("$CARGO_MANIFEST_DIR/ui-dist");

pub struct State {
    pub model: Option<CrepeModel>,
    pub takes_dir: PathBuf,
    pub session: Option<Session>,
    pub take_id: u64,
    pub last_export: Option<PathBuf>,
}

pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub headers: Vec<(&'static str, String)>,
}

#[derive(Deserialize)]
struct WithSettings {
    take_id: u64,
    #[serde(default)]
    settings: Settings,
}

impl State {
    pub fn new(model: Option<CrepeModel>, takes_dir: PathBuf) -> State {
        State { model, takes_dir, session: None, take_id: 0, last_export: None }
    }

    /// Open a take given on the command line (trusted path, may be outside takes/).
    pub fn preload(&mut self, path: &Path) -> Result<()> {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.open(&name, std::fs::read(path)?)
    }

    fn open(&mut self, name: &str, wav: Vec<u8>) -> Result<()> {
        let Some(model) = &self.model else { bail!("the CREPE model is not loaded") };
        self.session = Some(Session::load(name, wav, model)?);
        self.take_id += 1;
        Ok(())
    }
}

fn reply(status: u16, content_type: &'static str, body: Vec<u8>) -> Reply {
    Reply { status, content_type, body, headers: vec![] }
}

fn ok_json(v: impl serde::Serialize) -> Reply {
    reply(200, "application/json", serde_json::to_vec(&v).unwrap_or_default())
}

fn err(status: u16, msg: impl std::fmt::Display) -> Reply {
    reply(status, "application/json", serde_json::json!({ "error": msg.to_string() }).to_string().into_bytes())
}

/// A take file name: letters, digits, '-', '_', one ".wav", no path parts.
fn valid_take_file(name: &str) -> bool {
    name.len() <= 100
        && !name.starts_with('.')
        && name.ends_with(".wav")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Turn any requested name into a safe file stem.
fn sanitize_stem(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim_end_matches(".wav");
    let s: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() { "take".into() } else { s.chars().take(60).collect() }
}

fn unique_wav(dir: &Path, stem: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.wav"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}-{n}.wav"));
        n += 1;
    }
    p
}

/// Decode `%XX` escapes and `+` in a query value (byte-wise, so any input is safe).
fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| percent_decode(v))
    })
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

pub fn handle(state: &mut State, method: &str, url: &str, body: &[u8]) -> Reply {
    let path = url.split('?').next().unwrap_or("/");
    match (method, path) {
        ("GET", "/api/takes") => {
            let _ = std::fs::create_dir_all(&state.takes_dir);
            let mut names: Vec<String> = std::fs::read_dir(&state.takes_dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .filter(|n| valid_take_file(n))
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            ok_json(names)
        }
        ("POST", "/api/load") => {
            let requested = query_param(url, "name").unwrap_or_default();
            let (name, wav) = if body.is_empty() {
                if !valid_take_file(&requested) {
                    return err(400, format!("not a take name: {requested}"));
                }
                match std::fs::read(state.takes_dir.join(&requested)) {
                    Ok(w) => (requested, w),
                    Err(e) => return err(404, format!("{requested}: {e}")),
                }
            } else {
                if let Err(e) = std::fs::create_dir_all(&state.takes_dir) {
                    return err(500, e);
                }
                let path = unique_wav(&state.takes_dir, &sanitize_stem(&requested));
                if let Err(e) = std::fs::write(&path, body) {
                    return err(500, e);
                }
                (path.file_name().unwrap().to_string_lossy().into_owned(), body.to_vec())
            };
            match state.open(&name, wav) {
                Ok(()) => ok_json(serde_json::json!({
                    "take_id": state.take_id,
                    "info": state.session.as_ref().map(|s| s.info()),
                })),
                Err(e) => err(500, format!("{name} was saved but could not be analyzed: {e}")),
            }
        }
        ("POST", "/api/render") | ("POST", "/api/export") => {
            let req: WithSettings = match serde_json::from_slice(body) {
                Ok(r) => r,
                Err(e) => return err(400, e),
            };
            let Some(session) = state.session.as_ref().filter(|_| req.take_id == state.take_id) else {
                return err(409, "that take is no longer open");
            };
            if let Err(e) = req.settings.tuning() {
                return err(400, format!("tuning: {e}"));
            }
            if path == "/api/render" {
                return match session.render(&req.settings) {
                    Ok(r) => ok_json(r),
                    Err(e) => err(400, e),
                };
            }
            let bytes = match session.export_mid(&req.settings) {
                Ok(b) => b,
                Err(e) => return err(400, e),
            };
            let stem = session.name.trim_end_matches(".wav").to_string();
            if let Err(e) = std::fs::create_dir_all(&state.takes_dir) {
                return err(500, e);
            }
            let out = state.takes_dir.join(format!("{stem}_studio.mid"));
            if let Err(e) = std::fs::write(&out, bytes) {
                return err(500, e);
            }
            let file_name = out.file_name().unwrap().to_string_lossy().into_owned();
            let full = std::fs::canonicalize(&out).unwrap_or(out.clone());
            state.last_export = Some(full.clone());
            ok_json(serde_json::json!({ "path": full.display().to_string(), "file_name": file_name }))
        }
        ("GET", "/api/audio") => match &state.session {
            Some(s) => reply(200, "audio/wav", s.wav.clone()),
            None => err(409, "no take is open"),
        },
        ("GET", "/api/exported.mid") => match state.last_export.as_ref().and_then(|p| std::fs::read(p).ok().map(|b| (p, b))) {
            Some((p, b)) => {
                let mut r = reply(200, "audio/midi", b);
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                r.headers.push(("Content-Disposition", format!("attachment; filename=\"{name}\"")));
                r
            }
            None => err(404, "nothing exported yet"),
        },
        ("POST", "/api/reveal") => match &state.last_export {
            Some(p) => {
                let _ = std::process::Command::new("open").arg("-R").arg(p).spawn();
                ok_json(serde_json::json!({}))
            }
            None => err(404, "nothing exported yet"),
        },
        ("GET", p) => {
            let file = if p == "/" { "index.html" } else { p.trim_start_matches('/') };
            match UI.get_file(file) {
                Some(f) => reply(200, content_type(file), f.contents().to_vec()),
                None => err(404, format!("not found: {p}")),
            }
        }
        _ => err(404, format!("not found: {method} {path}")),
    }
}

/// Bind to 127.0.0.1 on `start_port`, or the next free port among 20. Port 0 = any.
pub fn bind(start_port: u16) -> Result<(tiny_http::Server, u16)> {
    let tries = if start_port == 0 { 1 } else { 20 };
    for port in (0..tries).map(|i| start_port.saturating_add(i)) {
        if let Ok(s) = tiny_http::Server::http(("127.0.0.1", port)) {
            let actual = s.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
            return Ok((s, actual));
        }
    }
    bail!("no free port from {start_port} to {}", start_port.saturating_add(19))
}

/// Answer requests one at a time until the process exits.
pub fn serve(server: &tiny_http::Server, state: &mut State) {
    for mut req in server.incoming_requests() {
        let mut body = Vec::new();
        let _ = req.as_reader().read_to_end(&mut body);
        let method = req.method().as_str().to_owned();
        let url = req.url().to_owned();
        let r = handle(state, &method, &url, &body);
        let mut resp = tiny_http::Response::from_data(r.body).with_status_code(r.status);
        if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", r.content_type) {
            resp.add_header(h);
        }
        for (k, v) in r.headers {
            if let Ok(h) = tiny_http::Header::from_bytes(k, v.as_bytes()) {
                resp.add_header(h);
            }
        }
        let _ = req.respond(resp);
    }
}
```

Note on `valid_take_file`: `%2E%2E%2Fsecret.wav` decodes to `../secret.wav`, which fails because `/` is not allowed; `.hidden.wav` fails the leading-dot rule.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p voxmpe --release --test server`
Expected: 8 passed (`full_flow_with_the_model` prints skipping if no model).

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt --all && cargo clippy --workspace --release --all-targets -- -D warnings
git add -A && git commit -m "Studio server: pure request handler, safe take names, port fallback

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `voxmpe studio`

**Files:**
- Modify: `crates/voxmpe/src/main.rs`
- Test: `crates/voxmpe/tests/cli.rs`

**Interfaces:**
- Consumes: `server::{State, bind, serve}`, `model::load_model`.
- Produces: `voxmpe studio [TAKE] [--model PATH] [--port 7878] [--takes DIR] [--no-open]`.

- [ ] **Step 1: Failing test**

Append to `crates/voxmpe/tests/cli.rs`:

```rust
#[test]
fn studio_has_help() {
    let out = Command::new(BIN).args(["studio", "--help"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("--port") && text.contains("--no-open"), "{text}");
}
```

Run: `cargo test -p voxmpe --release --test cli studio_has_help`. Expected: FAIL (unknown subcommand).

- [ ] **Step 2: Add the subcommand**

Add to `enum Cmd`:

```rust
    /// Open the studio in your browser: record or open takes, tune by ear, export
    Studio {
        /// A WAV to open right away
        take: Option<PathBuf>,
        /// CREPE model path (default: models/crepe-full.onnx or $VOXMPE_MODEL)
        #[arg(long)]
        model: Option<PathBuf>,
        /// First port to try (the next free one is used if busy)
        #[arg(long, default_value_t = 7878)]
        port: u16,
        /// Folder for recordings and exports
        #[arg(long, default_value = "takes")]
        takes: PathBuf,
        /// Don't open the browser
        #[arg(long)]
        no_open: bool,
    },
```

Add the match arm and function:

```rust
        Cmd::Studio { take, model, port, takes, no_open } => studio(take, model, port, takes, no_open),
```

```rust
fn studio(take: Option<PathBuf>, model: Option<PathBuf>, port: u16, takes: PathBuf, no_open: bool) -> Result<()> {
    let model = voxmpe::model::load_model(model.as_deref())?;
    let mut state = voxmpe::server::State::new(Some(model), takes);
    if let Some(p) = take {
        state.preload(&p).with_context(|| format!("opening {}", p.display()))?;
    }
    let (server, port) = voxmpe::server::bind(port)?;
    let url = format!("http://127.0.0.1:{port}/");
    println!("voxmpe studio: {url}  (Ctrl+C to stop)");
    if !no_open {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    voxmpe::server::serve(&server, &mut state);
    Ok(())
}
```

- [ ] **Step 3: Run, lint, commit**

Run: `cargo test -p voxmpe --release --test cli`. Expected: 4 passed.

```bash
cargo fmt --all && cargo clippy --workspace --release --all-targets -- -D warnings
git add -A && git commit -m "voxmpe studio: serve the UI locally and open the browser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: studio-ui scaffold and API client

**Files:**
- Create: `studio-ui/package.json`, `studio-ui/tsconfig.json`, `studio-ui/vite.config.ts`, `studio-ui/index.html`, `studio-ui/vendor/design/*` (synced), `studio-ui/src/styles.css`, `studio-ui/src/types.ts`, `studio-ui/src/api.ts`, `studio-ui/src/main.ts`, `studio-ui/.gitignore`
- Test: `studio-ui/src/api.test.ts`

**Interfaces:**
- Consumes: the Task 6 routes.
- Produces (`types.ts`): `Settings`, `TakeInfo`, `RNote`, `Rendered`, `LoadResp { take_id: number; info: TakeInfo }`, `ExportResp { path: string; file_name: string }`, all snake_case matching the Rust JSON. `DEFAULT_SETTINGS: Settings`, `LEGATO: Partial<Settings>`.
- Produces (`api.ts`): `class ApiError extends Error { status: number }`, `listTakes(): Promise<string[]>`, `openTake(name: string): Promise<LoadResp>`, `uploadTake(name: string, wav: ArrayBuffer): Promise<LoadResp>`, `render(takeId: number, s: Settings): Promise<Rendered>`, `exportMid(takeId: number, s: Settings): Promise<ExportResp>`, `reveal(): Promise<void>`, `AUDIO_URL = "/api/audio"`, `EXPORTED_URL = "/api/exported.mid"`.

- [ ] **Step 1: Project files**

`studio-ui/package.json`:

```json
{
  "name": "voxmpe-studio-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "check": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vite": "^6.0.5",
    "vitest": "^3.0.0"
  }
}
```

`studio-ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowJs": true
  },
  "include": ["src"]
}
```

`studio-ui/vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
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
});
```

`studio-ui/.gitignore`: `node_modules/`

Sync the design system: `~/Playground/design/sync.sh studio-ui` (writes `studio-ui/vendor/design/`, commit it). Its `tokens.css` references fonts relatively (`fonts/...`); Vite bundles them when the CSS is imported.

- [ ] **Step 2: `types.ts`**

```ts
export interface Settings {
  hold_ms: number;
  jump_hold_ms: number;
  jump_cents: number;
  gap_ms: number;
  split_cents: number;
  /** null = never split on loudness */
  onset_delta: number | null;
  tuning_name: string | null;
  tuning_scl: string | null;
  anchor_hz: number;
  /** null = MPE */
  single_channel: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  hold_ms: 90,
  jump_hold_ms: 90,
  jump_cents: 300,
  gap_ms: 80,
  split_cents: 70,
  onset_delta: 0.6,
  tuning_name: null,
  tuning_scl: null,
  anchor_hz: 261.625565,
  single_channel: null,
};

export const LEGATO: Partial<Settings> = { hold_ms: 180, gap_ms: 150, onset_delta: null };

export interface TakeInfo {
  name: string;
  duration_s: number;
  hop_s: number;
  contour: (number | null)[];
  loudness: number[];
  warning: string | null;
}

export type Cause = "gap" | "pitch" | "reattack";

export interface RNote {
  pitch: number;
  center: number;
  start: number;
  end: number;
  velocity: number;
  cause: Cause;
  bend: [number, number][];
  amp: [number, number][];
}

export interface Rendered {
  notes: RNote[];
  flags: string;
}

export interface LoadResp {
  take_id: number;
  info: TakeInfo;
}

export interface ExportResp {
  path: string;
  file_name: string;
}
```

- [ ] **Step 3: Failing API test**

`studio-ui/src/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, render } from "./api";
import { DEFAULT_SETTINGS } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("surfaces the server's error message and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "tuning: bad note count" }), { status: 400 })));
    const e = await render(1, DEFAULT_SETTINGS).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(e.message).toBe("tuning: bad note count");
  });

  it("sends take_id and settings", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ notes: [], flags: "" })));
    vi.stubGlobal("fetch", f);
    await render(7, DEFAULT_SETTINGS);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/render");
    expect(JSON.parse(init.body as string)).toEqual({ take_id: 7, settings: DEFAULT_SETTINGS });
  });
});
```

Run: `cd studio-ui && npm install && npm test`. Expected: FAIL, `./api` not found.

- [ ] **Step 4: `api.ts`**

```ts
import type { ExportResp, LoadResp, Rendered, Settings } from "./types";

export const AUDIO_URL = "/api/audio";
export const EXPORTED_URL = "/api/exported.mid";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const listTakes = () => call<string[]>("/api/takes");
export const openTake = (name: string) =>
  call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST" });
export const uploadTake = (name: string, wav: ArrayBuffer) =>
  call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST", body: wav });
export const render = (takeId: number, settings: Settings) =>
  call<Rendered>("/api/render", post({ take_id: takeId, settings }));
export const exportMid = (takeId: number, settings: Settings) =>
  call<ExportResp>("/api/export", post({ take_id: takeId, settings }));
export const reveal = () => call<void>("/api/reveal", { method: "POST" });
```

- [ ] **Step 5: `index.html`, `styles.css`, minimal `main.ts`**

`studio-ui/index.html`:

```html
<!doctype html>
<html lang="en" data-category="transcribe">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>voxmpe studio</title>
  </head>
  <body>
    <header class="bar">
      <strong>voxmpe</strong>
      <button id="record">Record</button>
      <input id="take-name" aria-label="Name for the next recording" />
      <span id="rec-status"></span>
      <select id="takes" aria-label="Open a take"></select>
      <label>Tuning <select id="tuning"><option value="">12-TET</option><option value="load">Load .scl...</option></select></label>
      <input id="scl-file" type="file" accept=".scl" hidden />
      <label>Anchor <input id="anchor" type="number" step="0.01" /> Hz</label>
      <span id="tuning-error" class="error" role="alert"></span>
      <span id="note-count"></span>
    </header>
    <p id="message" class="message" role="status"></p>
    <main>
      <canvas id="roll"></canvas>
      <aside id="controls"></aside>
    </main>
    <footer class="bar">
      <button id="play">Play (Space)</button>
      <span role="radiogroup" aria-label="Listen to">
        <label><input type="radio" name="listen" value="voice" /> Voice</label>
        <label><input type="radio" name="listen" value="midi" checked /> MIDI</label>
        <label><input type="radio" name="listen" value="both" /> Both</label>
      </span>
      <button id="save">Save .mid</button>
      <span id="drag" class="drag" draggable="false">Drag into Live</span>
      <button id="reveal" hidden>Reveal in Finder</button>
      <span id="saved-path"></span>
    </footer>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`studio-ui/src/styles.css`:

```css
@import "../vendor/design/tokens.css";

* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font-family: var(--font-sans); font-size: 14px; font-variant-numeric: tabular-nums; display: grid; grid-template-rows: auto auto 1fr auto; height: 100vh; }
.bar { display: flex; flex-wrap: wrap; gap: var(--space); align-items: center; padding: var(--space) calc(var(--space) * 2); background: var(--ground-2); border-bottom: var(--hairline); }
footer.bar { border-top: var(--hairline); border-bottom: 0; }
main { display: grid; grid-template-columns: 1fr 300px; min-height: 0; }
#roll { width: 100%; height: 100%; display: block; }
#controls { padding: calc(var(--space) * 2); border-left: var(--hairline); overflow: auto; font-size: 13px; }
#controls label { display: grid; grid-template-columns: 1fr auto; gap: calc(var(--space) / 2); margin-bottom: calc(var(--space) * 2); }
#controls label > span { color: var(--acc); }
#controls code { font-family: var(--font-mono); font-size: 12px; word-break: break-all; }
button, select, input[type="text"], input[type="number"] { font: inherit; color: var(--ink); background: var(--ground-2); border: var(--hairline); border-radius: var(--radius); padding: calc(var(--space) / 2) var(--space); }
button { cursor: pointer; }
button:hover { background: var(--band); }
button:disabled { opacity: 0.5; cursor: default; }
:focus-visible { outline: 1px solid var(--acc); outline-offset: 1px; }
input[type="checkbox"] { accent-color: var(--acc); }
/* Range sliders as in the design system's reference page: thin track, accent fill (--fill set from JS), square thumb. */
input[type="range"] { grid-column: 1 / -1; width: 100%; appearance: none; -webkit-appearance: none; height: 12px; background: transparent; cursor: pointer; }
input[type="range"]::-webkit-slider-runnable-track { height: 2px; background: linear-gradient(to right, var(--acc) var(--fill, 0%), var(--line) var(--fill, 0%)); }
input[type="range"]::-moz-range-track { height: 2px; background: linear-gradient(to right, var(--acc) var(--fill, 0%), var(--line) var(--fill, 0%)); }
input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -5px; background: var(--acc); border: 0; border-radius: 0; }
input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; background: var(--acc); border: 0; border-radius: 0; }
input[type="range"]:disabled { opacity: 0.4; }
.error { color: var(--ink); font-weight: 600; }
.message { margin: 0; padding: 0 calc(var(--space) * 2); color: var(--ink-mut); min-height: 1.4em; }
.drag { padding: calc(var(--space) / 2) var(--space); border: 1px dashed var(--line); color: var(--ink-mut); }
.drag[draggable="true"] { color: var(--ink); border-color: var(--acc); cursor: grab; }
@media (max-width: 700px) { main { grid-template-columns: 1fr; } #controls { border-left: 0; } }
```

`studio-ui/src/main.ts` (first version; later tasks extend it):

```ts
import "./styles.css";
import * as api from "./api";
import type { LoadResp } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function say(text: string) {
  $("message").textContent = text;
}

async function refreshTakes(select?: string) {
  const takes = await api.listTakes();
  const sel = $<HTMLSelectElement>("takes");
  sel.innerHTML = `<option value="">Open a take...</option>` + takes.map((t) => `<option>${t}</option>`).join("");
  if (select) sel.value = select;
}

export async function opened(r: LoadResp) {
  say(r.info.warning ?? `${r.info.name}: ${r.info.duration_s.toFixed(1)} s`);
  await refreshTakes(r.info.name);
}

$<HTMLSelectElement>("takes").addEventListener("change", async (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (!name) return;
  say(`Analyzing ${name}...`);
  try {
    await opened(await api.openTake(name));
  } catch (err) {
    say((err as Error).message);
  }
});

refreshTakes().catch((e) => say(e.message));
```

- [ ] **Step 6: Test, build, check it is served**

```bash
cd studio-ui && npm test && npm run build && cd ..
cargo build --release -p voxmpe
./target/release/voxmpe studio --no-open --port 7878 &
sleep 3; curl -s http://127.0.0.1:7878/ | grep -c 'voxmpe studio'; kill %1
```

Expected: tests pass, build writes `crates/voxmpe/ui-dist/`, curl prints `1`.

- [ ] **Step 7: Commit**

```bash
git add studio-ui && git commit -m "studio-ui: Vite scaffold on the design system, typed API client, take picker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Piano roll

**Files:**
- Create: `studio-ui/src/coords.ts`, `studio-ui/src/colors.ts`, `studio-ui/src/roll.ts`
- Modify: `studio-ui/src/main.ts`
- Test: `studio-ui/src/coords.test.ts`, `studio-ui/src/colors.test.ts`

**Interfaces:**
- Consumes: `TakeInfo`, `RNote`.
- Produces: `interface View { t0: number; t1: number; pLo: number; pHi: number; width: number; height: number }`, `fitView(info: TakeInfo, notes: RNote[], width: number, height: number): View`, `timeToX(v, t)`, `xToTime(v, x)`, `pitchToY(v, p)`; `drawRoll(canvas: HTMLCanvasElement, info: TakeInfo, notes: RNote[], playhead: number | null): View`; `LOUDNESS_LANE = 48` (px); `colors.ts`: `parseRgb(css: string): [number, number, number]`, `tint(acc: string, ground: string, p: number): string` (sRGB mix, `p` in 0..1, returns `rgb(r, g, b)`), `noteStrength(velocity: number): number` (= 0.35 + 0.65 * velocity), `isBlackKey(p: number): boolean`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { fitView, pitchToY, timeToX, xToTime } from "./coords";
import type { RNote, TakeInfo } from "./types";

const info: TakeInfo = { name: "t", duration_s: 4, hop_s: 0.01, contour: [60, null, 62.5], loudness: [0, 1, 0.5], warning: null };
const note = (pitch: number): RNote => ({ pitch, center: pitch, start: 1, end: 2, velocity: 1, cause: "gap", bend: [], amp: [] });

describe("coords", () => {
  it("fits every note and the contour with padding and at least an octave", () => {
    const v = fitView(info, [note(64)], 800, 400);
    expect(v.t0).toBe(0);
    expect(v.t1).toBe(4);
    expect(v.pLo).toBeLessThanOrEqual(58);
    expect(v.pHi).toBeGreaterThanOrEqual(66);
    expect(v.pHi - v.pLo).toBeGreaterThanOrEqual(12);
  });
  it("time and x are inverses", () => {
    const v = fitView(info, [], 800, 400);
    expect(xToTime(v, timeToX(v, 1.25))).toBeCloseTo(1.25);
  });
  it("higher pitch is higher on screen", () => {
    const v = fitView(info, [], 800, 400);
    expect(pitchToY(v, 70)).toBeLessThan(pitchToY(v, 60));
  });
  it("an empty take still gets a sane view", () => {
    const v = fitView({ ...info, contour: [], duration_s: 0 }, [], 800, 400);
    expect(v.t1).toBeGreaterThan(v.t0);
    expect(v.pHi).toBeGreaterThan(v.pLo);
  });
});
```

`studio-ui/src/colors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isBlackKey, noteStrength, parseRgb, tint } from "./colors";

describe("colors", () => {
  it("parses computed rgb and rgba strings", () => {
    expect(parseRgb("rgb(0, 116, 137)")).toEqual([0, 116, 137]);
    expect(parseRgb("rgba(242, 242, 238, 0.5)")).toEqual([242, 242, 238]);
  });
  it("tints between the ground and the accent", () => {
    expect(tint("rgb(0, 116, 137)", "rgb(239, 238, 233)", 1)).toBe("rgb(0, 116, 137)");
    expect(tint("rgb(0, 116, 137)", "rgb(239, 238, 233)", 0)).toBe("rgb(239, 238, 233)");
    expect(tint("rgb(0, 100, 200)", "rgb(200, 100, 0)", 0.5)).toBe("rgb(100, 100, 100)");
  });
  it("velocity maps to tint strength from 35% to 100%", () => {
    expect(noteStrength(0)).toBeCloseTo(0.35);
    expect(noteStrength(1)).toBeCloseTo(1);
  });
  it("knows the black keys", () => {
    expect([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map(isBlackKey)).toEqual(
      [false, true, false, true, false, false, true, false, true, false, true, false],
    );
  });
});
```

Run: `npm test`. Expected: FAIL, `./coords` and `./colors` not found.

- [ ] **Step 2: `coords.ts` and `colors.ts`**

`studio-ui/src/colors.ts`:

```ts
/** Canvas cannot read var() or light-dark(): tokens are resolved to rgb() with
 *  cssColor() from the design system, then mixed here. */
export function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** Mix `acc` over `ground` at strength `p` (0..1), in sRGB. */
export function tint(acc: string, ground: string, p: number): string {
  const a = parseRgb(acc);
  const g = parseRgb(ground);
  const c = a.map((v, i) => Math.round(v * p + g[i] * (1 - p)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** roll.md: tint strength 35% + 65% * velocity. */
export const noteStrength = (velocity: number) => 0.35 + 0.65 * velocity;

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlackKey = (p: number) => BLACK.has(((Math.round(p) % 12) + 12) % 12);
```

`studio-ui/src/coords.ts`:

```ts
import type { RNote, TakeInfo } from "./types";

export interface View { t0: number; t1: number; pLo: number; pHi: number; width: number; height: number; }

const PAD = 2;
const MIN_SPAN = 12;

export function fitView(info: TakeInfo, notes: RNote[], width: number, height: number): View {
  const ps: number[] = [];
  for (const c of info.contour) if (c !== null) ps.push(c);
  for (const n of notes) ps.push(n.pitch, n.center);
  let lo = ps.length ? Math.min(...ps) - PAD : 57;
  let hi = ps.length ? Math.max(...ps) + PAD : 72;
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  return { t0: 0, t1: Math.max(info.duration_s, 0.001), pLo: lo, pHi: hi, width, height };
}

export const timeToX = (v: View, t: number) => ((t - v.t0) / (v.t1 - v.t0)) * v.width;
export const xToTime = (v: View, x: number) => v.t0 + (x / v.width) * (v.t1 - v.t0);
export const pitchToY = (v: View, p: number) => v.height - ((p - v.pLo) / (v.pHi - v.pLo)) * v.height;
```

- [ ] **Step 3: `roll.ts`** (follows `vendor/design/roll.md`)

```ts
import { cssColor } from "../vendor/design/tokens.js";
import { isBlackKey, noteStrength, tint } from "./colors";
import { fitView, pitchToY, timeToX, type View } from "./coords";
import type { RNote, TakeInfo } from "./types";

export const LOUDNESS_LANE = 48;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function drawRoll(canvas: HTMLCanvasElement, info: TakeInfo, notes: RNote[], playhead: number | null): View {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Resolve tokens on every draw so theme and scheme changes apply on redraw.
  const c = {
    ground: cssColor("--ground"),
    band: cssColor("--band"),
    ink: cssColor("--ink"),
    mut: cssColor("--ink-mut"),
    acc: cssColor("--acc"),
  };
  const font = getComputedStyle(document.body).fontFamily;

  g.fillStyle = c.ground;
  g.fillRect(0, 0, w, h);
  const v = fitView(info, notes, w, h - LOUDNESS_LANE);
  const row = v.height / (v.pHi - v.pLo);

  // Key bands: black-key rows in --band, no lines. Octave label at each C.
  g.font = `10px ${font}`;
  g.textBaseline = "middle";
  for (let p = Math.floor(v.pLo); p <= Math.ceil(v.pHi); p++) {
    const top = pitchToY(v, p + 0.5);
    if (isBlackKey(p)) {
      g.fillStyle = c.band;
      g.fillRect(0, top, w, row);
    }
    if (p % 12 === 0) {
      g.fillStyle = c.mut;
      g.fillText(`${NAMES[0]}${p / 12 - 1}`, 4, pitchToY(v, p));
    }
  }

  // Raw sung contour: 1px --ink-mut at 50%.
  g.strokeStyle = c.mut;
  g.globalAlpha = 0.5;
  g.lineWidth = 1;
  g.beginPath();
  let pen = false;
  info.contour.forEach((pc, i) => {
    if (pc === null) { pen = false; return; }
    const x = timeToX(v, i * info.hop_s);
    const y = pitchToY(v, pc);
    if (pen) g.lineTo(x, y); else g.moveTo(x, y);
    pen = true;
  });
  g.stroke();
  g.globalAlpha = 1;

  // Notes: tints of the accent; the sounding note is full accent with an ink outline.
  const noteH = Math.max(2, row - 1);
  for (const n of notes) {
    const x0 = timeToX(v, n.start);
    const x1 = timeToX(v, n.end);
    const y = pitchToY(v, n.pitch) - noteH / 2;
    const width = Math.max(1, x1 - x0 - 1);
    const sounding = playhead !== null && playhead >= n.start && playhead < n.end;
    g.fillStyle = sounding ? c.acc : tint(c.acc, c.ground, noteStrength(n.velocity));
    g.fillRect(x0, y, width, noteH);
    if (sounding) {
      g.strokeStyle = c.ink;
      g.strokeRect(x0 + 0.5, y + 0.5, width - 1, noteH - 1);
    }
    // What started the note, by mark shape: nothing after a gap.
    g.strokeStyle = c.ink;
    if (n.cause === "pitch") {
      g.beginPath(); g.moveTo(x0, y + noteH + 2); g.lineTo(x0 + 4, y - 2); g.stroke();
    } else if (n.cause === "reattack") {
      g.fillStyle = c.ink;
      g.fillRect(x0, y - 2, 2, noteH + 4);
    }
    // Bend curve: 1px ink through the note.
    if (n.bend.length > 1) {
      g.beginPath();
      n.bend.forEach(([t, st], i) => {
        const bx = timeToX(v, t);
        const by = pitchToY(v, n.pitch + st);
        if (i) g.lineTo(bx, by); else g.moveTo(bx, by);
      });
      g.stroke();
    }
  }

  // Loudness lane: --ink-mut on a --band strip.
  const top = h - LOUDNESS_LANE;
  g.fillStyle = c.band;
  g.fillRect(0, top, w, LOUDNESS_LANE);
  g.fillStyle = c.mut;
  info.loudness.forEach((l, i) => {
    const x = timeToX(v, i * info.hop_s);
    g.fillRect(x, h - l * (LOUDNESS_LANE - 4), Math.max(1, timeToX(v, info.hop_s)), l * (LOUDNESS_LANE - 4));
  });

  if (playhead !== null) {
    g.strokeStyle = c.acc;
    const x = Math.round(timeToX(v, playhead)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  return v;
}
```

`NAMES[0]` is "C" because labels are drawn only on C rows.

- [ ] **Step 4: Wire into `main.ts`**

Add module state and redraw; `opened()` stores the take and the first render uses default settings (Task 10 replaces the render call with the live renderer):

```ts
import { drawRoll } from "./roll";
import { xToTime, type View } from "./coords";
import type { RNote, TakeInfo } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export const app = {
  takeId: 0,
  info: null as TakeInfo | null,
  notes: [] as RNote[],
  playhead: null as number | null,
  view: null as View | null,
};

export function redraw() {
  if (!app.info) return;
  app.view = drawRoll($<HTMLCanvasElement>("roll"), app.info, app.notes, app.playhead);
  $("note-count").textContent = `${app.notes.length} notes`;
}

window.addEventListener("resize", redraw);
// Canvas colours are resolved per draw; redraw when the system scheme flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
```

Replace `opened` with:

```ts
export async function opened(r: LoadResp) {
  app.takeId = r.take_id;
  app.info = r.info;
  say(r.info.warning ?? `${r.info.name}: ${r.info.duration_s.toFixed(1)} s`);
  await refreshTakes(r.info.name);
  app.notes = (await api.render(app.takeId, DEFAULT_SETTINGS)).notes;
  redraw();
}
```

- [ ] **Step 5: Test, build, commit**

Run: `npm test && npm run build`. Expected: pass, build succeeds.

```bash
git add studio-ui && git commit -m "studio-ui: piano roll on the design system (key bands, accent tints, cause ticks)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Controls, live re-render, tuning with last-good fallback

**Files:**
- Create: `studio-ui/src/throttle.ts`, `studio-ui/src/renderer.ts`, `studio-ui/src/controls.ts`
- Modify: `studio-ui/src/main.ts`
- Test: `studio-ui/src/throttle.test.ts`, `studio-ui/src/renderer.test.ts`

**Interfaces:**
- Consumes: `api.render`, `ApiError`, `Settings`, `DEFAULT_SETTINGS`, `LEGATO`.
- Produces:
  - `throttleLatest<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void`
  - `createRenderer(fetchRender: (takeId: number, s: Settings) => Promise<Rendered>, onResult: (r: Rendered, s: Settings) => void, onTuningError: (msg: string) => void)` returning `{ request(takeId: number, s: Settings): void; lastGood(): Settings }`: drops responses older than the latest request; on 400 whose message starts with `tuning`, calls `onTuningError` and re-requests with the new sliders but the last good tuning.
  - `buildControls(root: HTMLElement, initial: Settings, onChange: (s: Settings) => void): { set(s: Settings): void; setFlags(text: string): void }`

- [ ] **Step 1: Failing tests**

`throttle.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { throttleLatest } from "./throttle";

describe("throttleLatest", () => {
  it("runs at most once per interval and always runs the last call", () => {
    vi.useFakeTimers();
    const f = vi.fn();
    const t = throttleLatest(f, 33);
    t(1); t(2); t(3);
    expect(f.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(33);
    expect(f.mock.calls).toEqual([[1], [3]]);
    vi.advanceTimersByTime(100);
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
```

`renderer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { createRenderer } from "./renderer";
import { DEFAULT_SETTINGS, type Rendered, type Settings } from "./types";

const done = (flags: string): Rendered => ({ notes: [], flags });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createRenderer", () => {
  it("ignores a response that arrives after a newer request", async () => {
    const resolvers: ((r: Rendered) => void)[] = [];
    const fetchRender = vi.fn(() => new Promise<Rendered>((res) => resolvers.push(res)));
    const onResult = vi.fn();
    const r = createRenderer(fetchRender, onResult, vi.fn());
    r.request(1, { ...DEFAULT_SETTINGS, hold_ms: 100 });
    r.request(1, { ...DEFAULT_SETTINGS, hold_ms: 200 });
    resolvers[1](done("new"));
    resolvers[0](done("old"));
    await tick();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].flags).toBe("new");
  });

  it("keeps slider changes but falls back to the last good tuning", async () => {
    const good: Settings = { ...DEFAULT_SETTINGS, tuning_name: "ji.scl", tuning_scl: "good" };
    const calls: Settings[] = [];
    const fetchRender = vi.fn(async (_id: number, s: Settings) => {
      calls.push(s);
      if (s.tuning_scl === "bad") throw new ApiError(400, "tuning: bad note count");
      return done("ok");
    });
    const onTuningError = vi.fn();
    const r = createRenderer(fetchRender, vi.fn(), onTuningError);
    r.request(1, good);
    await tick();
    r.request(1, { ...good, hold_ms: 250, tuning_name: "broken.scl", tuning_scl: "bad" });
    await tick(); await tick();
    expect(onTuningError).toHaveBeenCalledWith("tuning: bad note count");
    const retry = calls[calls.length - 1];
    expect(retry.hold_ms).toBe(250);
    expect(retry.tuning_scl).toBe("good");
    expect(r.lastGood().tuning_name).toBe("ji.scl");
  });
});
```

Run: `npm test`. Expected: FAIL, modules not found.

- [ ] **Step 2: `throttle.ts`**

```ts
/** Call `fn` at most once per `ms`; the latest arguments always get a final call. */
export function throttleLatest<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = -Infinity;
  let pending: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    const now = Date.now();
    if (now - last >= ms && timer === null) {
      last = now;
      fn(...a);
      return;
    }
    pending = a;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, ms - (now - last));
    }
  };
}
```

- [ ] **Step 3: `renderer.ts`**

```ts
import { ApiError } from "./api";
import type { Rendered, Settings } from "./types";

export function createRenderer(
  fetchRender: (takeId: number, s: Settings) => Promise<Rendered>,
  onResult: (r: Rendered, s: Settings) => void,
  onTuningError: (msg: string) => void,
) {
  let seq = 0;
  let good: Settings | null = null;
  let first: Settings | null = null;
  const request = (takeId: number, s: Settings) => {
    first ??= s;
    const mine = ++seq;
    fetchRender(takeId, s).then(
      (r) => {
        if (mine !== seq) return;
        good = s;
        onResult(r, s);
      },
      (e) => {
        if (mine !== seq) return;
        if (e instanceof ApiError && e.status === 400 && e.message.startsWith("tuning") && good) {
          onTuningError(e.message);
          request(takeId, { ...s, tuning_name: good.tuning_name, tuning_scl: good.tuning_scl });
        }
      },
    );
  };
  /** The settings of the last successful render (or the first request, before any). */
  return { request, lastGood: (): Settings => good ?? first! };
}
```

- [ ] **Step 4: `controls.ts`**

```ts
import { DEFAULT_SETTINGS, LEGATO, type Settings } from "./types";

type NumKey = "hold_ms" | "jump_hold_ms" | "jump_cents" | "gap_ms" | "split_cents";
const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "hold_ms", label: "Hold (small moves)", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "jump_hold_ms", label: "Hold (big jumps)", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "jump_cents", label: "Big jump from", min: 100, max: 1200, step: 10, unit: "c" },
  { key: "gap_ms", label: "Gap that splits", min: 30, max: 400, step: 5, unit: "ms" },
  { key: "split_cents", label: "Pitch move that splits", min: 30, max: 300, step: 5, unit: "c" },
];

export function buildControls(root: HTMLElement, initial: Settings, onChange: (s: Settings) => void) {
  let s = { ...initial };
  root.innerHTML = "";
  const inputs = new Map<NumKey, [HTMLInputElement, HTMLElement]>();

  for (const d of SLIDERS) {
    const label = document.createElement("label");
    const val = document.createElement("span");
    const input = Object.assign(document.createElement("input"), { type: "range", min: String(d.min), max: String(d.max), step: String(d.step) });
    input.addEventListener("input", () => { s = { ...s, [d.key]: Number(input.value) }; sync(); onChange(s); });
    label.append(d.label, val, input);
    root.append(label);
    inputs.set(d.key, [input, val]);
  }

  const onset = document.createElement("label");
  const onsetVal = document.createElement("span");
  const onsetRange = Object.assign(document.createElement("input"), { type: "range", min: "0.1", max: "3", step: "0.05" });
  const onsetOff = Object.assign(document.createElement("input"), { type: "checkbox" });
  onsetRange.addEventListener("input", () => { s = { ...s, onset_delta: Number(onsetRange.value) }; sync(); onChange(s); });
  onsetOff.addEventListener("change", () => { s = { ...s, onset_delta: onsetOff.checked ? null : Number(onsetRange.value) }; sync(); onChange(s); });
  const offLabel = document.createElement("span");
  offLabel.append(onsetOff, " off");
  onset.append("Loudness re-attack", onsetVal, onsetRange, offLabel);
  root.append(onset);

  const buttons = document.createElement("div");
  const legato = Object.assign(document.createElement("button"), { textContent: "Legato" });
  const reset = Object.assign(document.createElement("button"), { textContent: "Reset" });
  const keepTuning = (base: Settings): Settings => ({ ...base, tuning_name: s.tuning_name, tuning_scl: s.tuning_scl, anchor_hz: s.anchor_hz });
  legato.addEventListener("click", () => { s = keepTuning({ ...DEFAULT_SETTINGS, ...LEGATO }); sync(); onChange(s); });
  reset.addEventListener("click", () => { s = keepTuning(DEFAULT_SETTINGS); sync(); onChange(s); });
  buttons.append(legato, " ", reset);
  root.append(buttons);

  const flags = document.createElement("p");
  const code = document.createElement("code");
  const copy = Object.assign(document.createElement("button"), { textContent: "Copy as flags" });
  copy.addEventListener("click", () => navigator.clipboard.writeText(code.textContent ?? ""));
  flags.append(code, " ", copy);
  root.append(flags);

  function sync() {
    for (const [key, [input, val]] of inputs) {
      const d = SLIDERS.find((x) => x.key === key)!;
      input.value = String(s[key]);
      input.style.setProperty("--fill", `${((s[key] - d.min) / (d.max - d.min)) * 100}%`);
      val.textContent = `${s[key]} ${d.unit}`;
    }
    onsetOff.checked = s.onset_delta === null;
    onsetRange.disabled = s.onset_delta === null;
    if (s.onset_delta !== null) onsetRange.value = String(s.onset_delta);
    onsetRange.style.setProperty("--fill", `${((Number(onsetRange.value) - 0.1) / (3 - 0.1)) * 100}%`);
    onsetVal.textContent = s.onset_delta === null ? "off" : `+${Math.round(s.onset_delta * 100)}%`;
  }
  sync();
  return {
    set(next: Settings) { s = { ...next }; sync(); },
    setFlags(text: string) { code.textContent = text || "(defaults)"; },
  };
}
```

- [ ] **Step 5: Wire into `main.ts`**

```ts
import { buildControls } from "./controls";
import { createRenderer } from "./renderer";
import { throttleLatest } from "./throttle";

let settings: Settings = { ...DEFAULT_SETTINGS };

const renderer = createRenderer(
  api.render,
  (r, s) => {
    app.notes = r.notes;
    controls.setFlags(r.flags);
    if (s.tuning_scl === settings.tuning_scl) $("tuning-error").textContent = "";
    redraw();
    onNotesChanged();
  },
  (msg) => {
    $("tuning-error").textContent = `${msg} (kept the previous tuning)`;
    settings = { ...settings, tuning_name: renderer.lastGood().tuning_name, tuning_scl: renderer.lastGood().tuning_scl };
    $<HTMLSelectElement>("tuning").value = settings.tuning_name ? "loaded" : "";
  },
);
const rerender = throttleLatest(() => app.takeId && renderer.request(app.takeId, settings), 33);
const controls = buildControls($("controls"), settings, (s) => { settings = s; rerender(); });

/** Hook for playback (Task 11) to reschedule when notes change. */
export let onNotesChanged: () => void = () => {};
export function setOnNotesChanged(f: () => void) { onNotesChanged = f; }

// Tuning picker and anchor.
const tuningSel = $<HTMLSelectElement>("tuning");
const sclFile = $<HTMLInputElement>("scl-file");
const anchor = $<HTMLInputElement>("anchor");
anchor.value = String(settings.anchor_hz);
tuningSel.addEventListener("change", () => {
  if (tuningSel.value === "load") { sclFile.click(); return; }
  if (tuningSel.value === "") { settings = { ...settings, tuning_name: null, tuning_scl: null }; rerender(); }
});
sclFile.addEventListener("change", async () => {
  const f = sclFile.files?.[0];
  if (!f) return;
  settings = { ...settings, tuning_name: f.name, tuning_scl: await f.text() };
  let opt = tuningSel.querySelector<HTMLOptionElement>('option[value="loaded"]');
  if (!opt) { opt = Object.assign(document.createElement("option"), { value: "loaded" }); tuningSel.insertBefore(opt, tuningSel.lastElementChild); }
  opt.textContent = f.name;
  tuningSel.value = "loaded";
  sclFile.value = "";
  rerender();
});
anchor.addEventListener("change", () => {
  const hz = Number(anchor.value);
  if (hz > 0) { settings = { ...settings, anchor_hz: hz }; rerender(); }
});
```

In `opened()`, replace the direct `api.render` call with `renderer.request(app.takeId, settings);` and drop the `redraw()` that followed it (the renderer redraws).

- [ ] **Step 6: Test, build, commit**

Run: `npm test && npm run build`. Expected: all pass.

```bash
git add studio-ui && git commit -m "studio-ui: sliders, legato and reset, live re-render, tuning picker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Listening: voice, MIDI preview, both

**Files:**
- Create: `studio-ui/src/synth.ts`, `studio-ui/src/player.ts`
- Modify: `studio-ui/src/main.ts`
- Test: `studio-ui/src/synth.test.ts`

**Interfaces:**
- Consumes: `RNote`, `AUDIO_URL`, `setOnNotesChanged`, `app`, `redraw`.
- Produces:
  - `midiToHz(m: number): number`
  - `interface Automation { start: number; end: number; freq: [number, number][]; gain: [number, number][] }` (song-time seconds)
  - `noteAutomation(n: RNote): Automation`
  - `fromTime(a: Automation, t: number): Automation | null` (null if the note ends before `t`; otherwise events before `t` collapse into one event at `t` carrying the latest value)
  - `class Player { load(url: string): Promise<void>; play(from: number): void; stop(): void; setNotes(notes: RNote[]): void; setMode(m: "voice" | "midi" | "both"): void; get playing(): boolean; position(): number }`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { fromTime, midiToHz, noteAutomation } from "./synth";
import type { RNote } from "./types";

const n = (over: Partial<RNote> = {}): RNote => ({ pitch: 69, center: 69, start: 1, end: 2, velocity: 0.8, cause: "gap", bend: [], amp: [], ...over });

describe("synth", () => {
  it("A4 is 440 Hz", () => expect(midiToHz(69)).toBeCloseTo(440));
  it("a note without curves holds its pitch and velocity", () => {
    const a = noteAutomation(n());
    expect(a.freq).toEqual([[1, midiToHz(69)]]);
    expect(a.gain[0][1]).toBeCloseTo(0.25 * 0.8);
  });
  it("follows the bend curve in semitones", () => {
    const a = noteAutomation(n({ bend: [[1, 0], [1.5, 1]] }));
    expect(a.freq[1][1]).toBeCloseTo(466.16, 1);
  });
  it("starting mid-note carries the current value to the start point", () => {
    const a = fromTime(noteAutomation(n({ bend: [[1, 0], [1.2, 0.5], [1.8, 1]] })), 1.5)!;
    expect(a.start).toBe(1.5);
    expect(a.freq[0]).toEqual([1.5, midiToHz(69.5)]);
    expect(a.freq[1][0]).toBe(1.8);
  });
  it("notes that ended are dropped", () => {
    expect(fromTime(noteAutomation(n()), 3)).toBeNull();
  });
});
```

Run: `npm test`. Expected: FAIL, `./synth` not found.

- [ ] **Step 2: `synth.ts`**

```ts
import type { RNote } from "./types";

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export interface Automation { start: number; end: number; freq: [number, number][]; gain: [number, number][]; }

/** Peak oscillator gain, so a few overlapping notes don't clip. */
const LEVEL = 0.25;

export function noteAutomation(n: RNote): Automation {
  const freq: [number, number][] = n.bend.length
    ? n.bend.map(([t, st]) => [t, midiToHz(n.pitch + st)])
    : [[n.start, midiToHz(n.pitch)]];
  const gain: [number, number][] = n.amp.length
    ? n.amp.map(([t, a]) => [t, LEVEL * a])
    : [[n.start, LEVEL * n.velocity]];
  return { start: n.start, end: n.end, freq, gain };
}

function clip(events: [number, number][], t: number): [number, number][] {
  const before = events.filter(([et]) => et <= t);
  const after = events.filter(([et]) => et > t);
  const carry = before.length ? before[before.length - 1][1] : after[0]?.[1];
  return carry === undefined ? after : [[t, carry], ...after];
}

export function fromTime(a: Automation, t: number): Automation | null {
  if (a.end <= t) return null;
  if (a.start >= t) return a;
  return { start: t, end: a.end, freq: clip(a.freq, t), gain: clip(a.gain, t) };
}
```

- [ ] **Step 3: `player.ts`**

```ts
import { fromTime, noteAutomation } from "./synth";
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
      g.gain.setValueAtTime(g.gain.value, at(a.end) - 0.01);
      g.gain.linearRampToValueAtTime(0, at(a.end));
      osc.start(at(a.start));
      osc.stop(at(a.end) + 0.02);
      this.oscs.push(osc);
    }
  }
}
```

- [ ] **Step 4: Wire into `main.ts`**

```ts
import { Player } from "./player";
import { AUDIO_URL } from "./api";

const player = new Player();
setOnNotesChanged(() => player.setNotes(app.notes));

async function togglePlay() {
  if (player.playing) player.stop();
  else player.play(app.playhead ?? 0);
  $("play").textContent = player.playing ? "Stop (Space)" : "Play (Space)";
  tickPlayhead();
}

function tickPlayhead() {
  app.playhead = player.position();
  redraw();
  if (player.playing) requestAnimationFrame(tickPlayhead);
  else $("play").textContent = "Play (Space)";
}

$("play").addEventListener("click", togglePlay);
document.querySelectorAll<HTMLInputElement>('input[name="listen"]').forEach((r) =>
  r.addEventListener("change", () => player.setMode(r.value as "voice" | "midi" | "both")),
);
$<HTMLCanvasElement>("roll").addEventListener("click", (e) => {
  if (!app.view) return;
  const t = xToTime(app.view, e.offsetX);
  app.playhead = t;
  if (player.playing) player.play(t);
  redraw();
});
export function onSpace(e: KeyboardEvent, recording: boolean) {
  if (e.code !== "Space" || (e.target as HTMLElement).tagName === "INPUT") return false;
  e.preventDefault();
  if (!recording) void togglePlay();
  return true;
}
```

In `opened()`, before rendering: `player.stop(); app.playhead = 0; await player.load(AUDIO_URL);`. Add a key handler (Task 12 routes Space to recording when active): `document.addEventListener("keydown", (e) => onSpace(e, false));`.

- [ ] **Step 5: Test, build, commit**

Run: `npm test && npm run build`. Expected: pass.

```bash
git add studio-ui && git commit -m "studio-ui: play voice, MIDI preview following bends, or both

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Recording in the browser

**Files:**
- Create: `studio-ui/src/wav.ts`, `studio-ui/src/recorder.ts`
- Modify: `studio-ui/src/main.ts`
- Test: `studio-ui/src/wav.test.ts`

**Interfaces:**
- Consumes: `api.uploadTake`, `opened`, `say`, `onSpace`.
- Produces: `encodeWavFloat32(samples: Float32Array, sampleRate: number): ArrayBuffer`, `concat(chunks: Float32Array[]): Float32Array`; `class Recorder { start(onLevel: (peak: number) => void): Promise<void>; stop(): Promise<{ wav: ArrayBuffer; seconds: number }>; get active(): boolean }`; `defaultTakeName(d: Date): string` (in `recorder.ts`, `take-YYYYMMDD-HHMMSS`).

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { concat, encodeWavFloat32 } from "./wav";
import { defaultTakeName } from "./recorder";

describe("wav", () => {
  it("writes the float WAV layout the server decodes", () => {
    const buf = encodeWavFloat32(new Float32Array([0.5, -0.25, 0]), 96000);
    const v = new DataView(buf);
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
    expect(str(0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 12);
    expect(str(8, 8)).toBe("WAVEfmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(96000);
    expect(v.getUint16(34, true)).toBe(32);
    expect(str(36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(12);
    expect(v.getFloat32(44, true)).toBe(0.5);
    expect(v.getFloat32(48, true)).toBe(-0.25);
  });
  it("concatenates chunks in order", () => {
    expect(Array.from(concat([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3]);
  });
  it("names takes by date and time", () => {
    expect(defaultTakeName(new Date(2026, 8, 24, 9, 5, 7))).toBe("take-20260924-090507");
  });
});
```

Run: `npm test`. Expected: FAIL. (This layout must match `decodes_the_browser_float_wav_layout` in Task 4; if Task 4 switched to an 18-byte fmt chunk, write that layout here and update these offsets.)

- [ ] **Step 2: `wav.ts`**

```ts
/** Mono 32-bit float WAV: RIFF, 16-byte fmt chunk (format 3), data. Mirrors
 *  decodes_the_browser_float_wav_layout in crates/voxmpe/src/audio.rs. */
export function encodeWavFloat32(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setFloat32(44 + i * 4, samples[i], true);
  return buf;
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
```

- [ ] **Step 3: `recorder.ts`**

```ts
import { concat, encodeWavFloat32 } from "./wav";

/** Worklet that downmixes the mic to mono and posts each block. */
const TAP = `class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const n = chans[0].length;
      const mono = new Float32Array(n);
      for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i] / chans.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor("tap", Tap);`;

const pad = (n: number) => String(n).padStart(2, "0");
export const defaultTakeName = (d: Date) =>
  `take-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];

  get active() { return this.ctx !== null; }

  async start(onLevel: (peak: number) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: "text/javascript" })));
    const src = this.ctx.createMediaStreamSource(this.stream);
    const tap = new AudioWorkletNode(this.ctx, "tap");
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // keeps the graph pulling without monitoring the mic
    this.chunks = [];
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.chunks.push(e.data);
      let p = 0;
      for (const s of e.data) p = Math.max(p, Math.abs(s));
      onLevel(p);
    };
    src.connect(tap).connect(mute).connect(this.ctx.destination);
  }

  async stop() {
    const ctx = this.ctx!;
    this.stream?.getTracks().forEach((t) => t.stop());
    const samples = concat(this.chunks);
    const rate = ctx.sampleRate;
    await ctx.close();
    this.ctx = null;
    this.stream = null;
    return { wav: encodeWavFloat32(samples, rate), seconds: samples.length / rate };
  }
}

/** A readable reason for a getUserMedia failure. */
export function micError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError")
    return "Mic access was blocked. Allow it for this page in the browser's site settings, and for the browser in macOS System Settings > Privacy & Security > Microphone.";
  if (name === "NotFoundError") return "No microphone found. Plug one in, or open a WAV instead.";
  return `Could not start recording: ${(e as Error)?.message ?? e}`;
}
```

- [ ] **Step 4: Wire into `main.ts`**

```ts
import { Recorder, defaultTakeName, micError } from "./recorder";

const recorder = new Recorder();
const takeName = $<HTMLInputElement>("take-name");
takeName.value = defaultTakeName(new Date());

async function toggleRecord() {
  const btn = $<HTMLButtonElement>("record");
  if (!recorder.active) {
    player.stop();
    try {
      const t0 = performance.now();
      await recorder.start((peak) => {
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        $("rec-status").textContent = `${secs} s  ${"|".repeat(Math.round(peak * 20))}`;
      });
      btn.textContent = "Stop recording (Space)";
    } catch (e) {
      say(micError(e));
    }
    return;
  }
  btn.disabled = true;
  const { wav, seconds } = await recorder.stop();
  btn.textContent = "Record";
  $("rec-status").textContent = "";
  say(`Saving and analyzing ${seconds.toFixed(1)} s...`);
  try {
    await opened(await api.uploadTake(takeName.value, wav));
    takeName.value = defaultTakeName(new Date());
  } catch (e) {
    say((e as Error).message);
  } finally {
    btn.disabled = false;
  }
}

$("record").addEventListener("click", toggleRecord);
```

Replace the keydown handler from Task 11 with:

```ts
document.addEventListener("keydown", (e) => {
  if (recorder.active && e.code === "Space") { e.preventDefault(); void toggleRecord(); return; }
  onSpace(e, recorder.active);
});
```

- [ ] **Step 5: Test, build, commit**

Run: `npm test && npm run build`. Expected: pass. Do not run anything that opens the microphone; the user checks recording in Task 15.

```bash
git add studio-ui && git commit -m "studio-ui: record from the mic in the browser, save to takes/, open

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Save, drag into Live, reveal in Finder

**Files:**
- Create: `studio-ui/src/export.ts`
- Modify: `studio-ui/src/main.ts`
- Test: `studio-ui/src/export.test.ts`

**Interfaces:**
- Consumes: `api.exportMid`, `api.reveal`, `EXPORTED_URL`, `settings`, `app.takeId`.
- Produces: `downloadUrlData(fileName: string, origin: string): string` (Chrome `DownloadURL` format `audio/midi:<name>:<absolute url>`), `settingsKey(s: Settings): string`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { downloadUrlData, settingsKey } from "./export";
import { DEFAULT_SETTINGS } from "./types";

describe("export", () => {
  it("builds Chrome's DownloadURL value", () => {
    expect(downloadUrlData("take1_studio.mid", "http://127.0.0.1:7878")).toBe(
      "audio/midi:take1_studio.mid:http://127.0.0.1:7878/api/exported.mid",
    );
  });
  it("settings changes make a saved export stale", () => {
    expect(settingsKey(DEFAULT_SETTINGS)).not.toBe(settingsKey({ ...DEFAULT_SETTINGS, hold_ms: 91 }));
    expect(settingsKey(DEFAULT_SETTINGS)).toBe(settingsKey({ ...DEFAULT_SETTINGS }));
  });
});
```

Run: `npm test`. Expected: FAIL.

- [ ] **Step 2: `export.ts`**

```ts
import { EXPORTED_URL } from "./api";
import type { Settings } from "./types";

export const downloadUrlData = (fileName: string, origin: string) => `audio/midi:${fileName}:${origin}${EXPORTED_URL}`;
export const settingsKey = (s: Settings) => JSON.stringify(s);
```

- [ ] **Step 3: Wire into `main.ts`**

```ts
import { downloadUrlData, settingsKey } from "./export";

let saved: { key: string; fileName: string; takeId: number } | null = null;
const drag = $("drag");

function updateDrag() {
  const fresh = saved && saved.takeId === app.takeId && saved.key === settingsKey(settings);
  drag.setAttribute("draggable", fresh ? "true" : "false");
  drag.textContent = fresh ? `Drag ${saved!.fileName} into Live` : saved ? "Save again to drag the latest" : "Save first to drag";
}

$("save").addEventListener("click", async () => {
  if (!app.takeId) return;
  try {
    const r = await api.exportMid(app.takeId, settings);
    saved = { key: settingsKey(settings), fileName: r.file_name, takeId: app.takeId };
    $("saved-path").textContent = r.path;
    $("reveal").hidden = false;
  } catch (e) {
    say((e as Error).message);
  }
  updateDrag();
});

drag.addEventListener("dragstart", (e) => {
  if (!saved) return;
  e.dataTransfer?.setData("DownloadURL", downloadUrlData(saved.fileName, location.origin));
});

$("reveal").addEventListener("click", () => void api.reveal());
```

Call `updateDrag()` at the end of the renderer's `onResult` callback and in `opened()`.

- [ ] **Step 4: Test, build, commit**

Run: `npm test && npm run build && cargo build --release -p voxmpe`. Expected: pass.

```bash
git add studio-ui && git commit -m "studio-ui: save .mid, drag into Live, reveal in Finder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Docs

**Files:**
- Create: `README.md` (repo root)
- Modify: `crates/voxmpe-core/README.md`, `crates/voxmpe/README.md`

- [ ] **Step 1: Root README**

```markdown
# voxmpe

Sing, get expressive MPE MIDI. voxmpe tracks a sung phrase with CREPE, splits it into notes, and writes MIDI that keeps the voice's glides, vibrato and dynamics as per-note expression. Optionally snap it to any Scala tuning.

## Studio

    voxmpe studio

Opens a local page where you record (or open) a take, move the note-split settings while listening, and save or drag the `.mid` into Ableton Live. Recordings and exports go to `takes/`.

## CLI

    voxmpe convert take.wav -o take.mid --legato --hold-ms 150

The studio's "Copy as flags" gives the exact flags for the settings you chose.

## Setup

1. Get the CREPE model: see `models/README.md`.
2. Build the UI once: `cd studio-ui && npm install && npm run build`.
3. `cargo install --path crates/voxmpe` (or `cargo run --release -p voxmpe -- studio`).

## Layout

- `crates/voxmpe-core`: the engine library (pitch tracking, segmentation, MPE MIDI writer).
- `crates/voxmpe`: the app (studio, CLI, Scala tuning).
- `studio-ui`: the studio's browser UI.
```

- [ ] **Step 2: Crate READMEs**

In `crates/voxmpe-core/README.md`, replace every `voxmidi-core` with `voxmpe-core`, `microtonal-voxmidi` with `voxmpe`, and the build section's model path with `models/crepe-full.onnx at the repo root (see models/README.md)`. Replace `crates/voxmpe/README.md` with a short app README: what `studio` and `convert` do, pointing to the root README, and the existing module table for `scala`, `quantize`, `retune`, `chord`.

Check: `grep -rn $'\u2014' README.md crates/*/README.md models/README.md` prints nothing new from this task (fix any that appear in lines you wrote).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Docs: voxmpe README, studio and CLI usage

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: The user's checkpoint (hand over; do not run the mic)

- [ ] **Step 1: Full automated pass**

```bash
cargo fmt --all --check && cargo clippy --workspace --release --all-targets -- -D warnings
cargo test --workspace --release 2>&1 | grep -E 'test result|FAILED'
cd studio-ui && npm run check && npm test && npm run build
```

Expected: everything passes.

- [ ] **Step 2: Give the user these steps**

```text
cd ~/Playground/voxmpe && cargo run --release -p voxmpe -- studio
```

1. Click Record, allow the mic, sing a phrase with lyrics, press Space to stop.
2. Watch the roll: note colours show what started each note.
3. Press Space to play; switch Voice / MIDI / Both.
4. Move Hold, Gap and Pitch move while playing; listen for splits.
5. Load a `.scl` tuning; try a broken one and check the error keeps the old tuning.
6. Save, then drag the handle into an MPE instrument in Live (Chrome), or Reveal in Finder and drag from there.
7. Tell me the settings that sounded right ("Copy as flags").

---

### Task 16: GitHub (only after the user says go, in that moment)

- [ ] **Step 1: Ask the user** whether to rename `swwallowws/voxmidi-core` to `voxmpe`, push branch `studio`, and archive `swwallowws/microtonal-voxmidi` with a pointer. Wait for an explicit yes.

- [ ] **Step 2: On yes**

```bash
cd ~/Playground/voxmpe
gh repo rename voxmpe -R swwallowws/voxmidi-core --yes
git remote set-url origin https://github.com/swwallowws/voxmpe.git
git push -u origin studio
cd ~/Playground/microtonal-voxmidi
printf '# microtonal-voxmidi (moved)\n\nThis project now lives in [swwallowws/voxmpe](https://github.com/swwallowws/voxmpe), crate `voxmpe`, with its full history.\n' > README.md
git commit -am "Point to voxmpe

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push
gh repo archive swwallowws/microtonal-voxmidi --yes
```

- [ ] **Step 3: Verify**

Run: `gh repo view swwallowws/voxmpe --json name,visibility,isArchived && gh repo view swwallowws/microtonal-voxmidi --json isArchived`
Expected: `voxmpe` PRIVATE not archived; `microtonal-voxmidi` archived. Ask the user whether to delete the local `~/Playground/microtonal-voxmidi` folder (its history is in voxmpe).
