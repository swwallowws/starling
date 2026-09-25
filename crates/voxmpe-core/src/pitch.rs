//! CREPE pitch tracking via `tract-onnx` (pure-Rust inference).
//!
//! Mirrors torchcrepe preprocessing exactly (see `scripts/export_crepe.py`):
//! 16 kHz mono, 1024-sample frames, 160-sample hop, centered, per-frame
//! mean/std normalization. Decodes the 360-bin activation into f0 via a local
//! weighted average of cents around the argmax bin.

use anyhow::{bail, Context, Result};
use tract_onnx::prelude::*;

use crate::resample::resample;

pub const CREPE_SR: u32 = 16_000;
pub const WINDOW: usize = 1024;
pub const HOP: usize = 160; // 10 ms at 16 kHz
const BINS: usize = 360;
const CENTS_0: f32 = 1997.3794; // cents of bin 0 (CREPE constant)
const CENTS_PER_BIN: f32 = 20.0;
/// Frames per inference batch (model is compiled for this fixed shape). Kept
/// small so the zero-padded tail of the final batch wastes little compute on
/// short clips; per-frame cost dominates, so batch size barely affects throughput.
const BATCH: usize = 32;

type Runnable = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

/// A loaded CREPE model ready for repeated inference.
pub struct CrepeModel {
    plan: Runnable,
}

/// Raw per-frame pitch estimate (before voicing gate / feature merge).
#[derive(Debug, Clone, Copy)]
pub struct RawPitch {
    pub time: f32,
    pub f0_hz: f32,
    pub confidence: f32,
}

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
    Prepared {
        audio16,
        n_frames,
        active,
    }
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

/// CREPE cents (relative to a 10 Hz reference) -> Hz. Folded onto the shared
/// [`crate::interval`] anchor math rather than duplicating the 2^(c/1200) form.
#[inline]
fn cents_to_hz(cents: f32) -> f32 {
    crate::interval::cents_to_freq(cents as f64, 10.0) as f32
}

impl CrepeModel {
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

    /// Track pitch over mono `audio` at `sample_rate`. Returns one [`RawPitch`]
    /// per 10 ms hop (at the original-audio time base).
    pub fn track(&self, audio: &[f32], sample_rate: u32) -> Result<Vec<RawPitch>> {
        self.track_gated(audio, sample_rate, 0.0)
    }

    /// Like [`track`](Self::track), but skips inference on frames whose RMS is
    /// below `rms_floor` (they come back as f0 0, confidence 0). The RMS is the
    /// same per-frame value [`crate::features::extract`] computes, so with the
    /// voicing gate's floor this only skips frames that would be unvoiced anyway.
    pub fn track_gated(
        &self,
        audio: &[f32],
        sample_rate: u32,
        rms_floor: f32,
    ) -> Result<Vec<RawPitch>> {
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
    }

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

    /// Run `frames` through the model in fixed-size batches, writing
    /// `(f0_hz, confidence)` per frame into `out` (same length as `frames`).
    fn run_batches(&self, frames: &[[f32; WINDOW]], out: &mut [(f32, f32)]) -> Result<()> {
        for (chunk, out) in frames.chunks(BATCH).zip(out.chunks_mut(BATCH)) {
            // Build a [BATCH, WINDOW] buffer, zero-padding the tail of the last chunk.
            let mut buf = vec![0.0f32; BATCH * WINDOW];
            for (r, frame) in chunk.iter().enumerate() {
                buf[r * WINDOW..(r + 1) * WINDOW].copy_from_slice(frame);
            }
            let input = Tensor::from_shape(&[BATCH, WINDOW], &buf)?;
            let result = self.plan.run(tvec!(input.into()))?;
            let act = result[0].to_array_view::<f32>()?;
            let act = act.as_slice().context("activation not contiguous")?;
            for (r, slot) in out.iter_mut().enumerate() {
                *slot = decode_row(&act[r * BINS..(r + 1) * BINS]);
            }
        }
        Ok(())
    }
}

/// Decode one 360-bin activation row -> (f0_hz, confidence).
#[allow(clippy::needless_range_loop)] // index maps directly to a cents value
fn decode_row(row: &[f32]) -> (f32, f32) {
    let mut argmax = 0usize;
    let mut peak = row[0];
    for (i, &v) in row.iter().enumerate() {
        if v > peak {
            peak = v;
            argmax = i;
        }
    }
    let lo = argmax.saturating_sub(4);
    let hi = (argmax + 5).min(BINS);
    let mut wsum = 0.0f32;
    let mut csum = 0.0f32;
    for b in lo..hi {
        let cents = CENTS_0 + CENTS_PER_BIN * b as f32;
        wsum += row[b];
        csum += row[b] * cents;
    }
    let cents = if wsum > 1e-10 { csum / wsum } else { 0.0 };
    (cents_to_hz(cents), peak)
}

/// Center-pad 16 kHz audio with zeros so frame `i` (1024 samples, 10 ms hop)
/// starts at `i * HOP`.
fn pad(audio16: &[f32]) -> Vec<f32> {
    let pad = WINDOW / 2;
    // Center padding (zeros), matching torch F.pad.
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
