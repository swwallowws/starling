//! CREPE pitch tracking via `tract-onnx` (pure-Rust inference).
//!
//! Mirrors torchcrepe preprocessing exactly (see `scripts/export_crepe.py`):
//! 16 kHz mono, 1024-sample frames, 160-sample hop, centered, per-frame
//! mean/std normalization. Decodes the 360-bin activation into f0 via a local
//! weighted average of cents around the argmax bin.

use anyhow::{Context, Result};
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

/// CREPE cents (relative to a 10 Hz reference) -> Hz. Folded onto the shared
/// [`crate::interval`] anchor math rather than duplicating the 2^(c/1200) form.
#[inline]
fn cents_to_hz(cents: f32) -> f32 {
    crate::interval::cents_to_freq(cents as f64, 10.0) as f32
}

impl CrepeModel {
    pub fn from_path(path: &str) -> Result<Self> {
        let plan = tract_onnx::onnx()
            .model_for_path(path)
            .with_context(|| format!("loading CREPE ONNX from {path}"))?
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
        let audio16 = resample(audio, sample_rate, CREPE_SR);
        let (frames, rms) = frame_and_normalize(&audio16);
        let n = frames.len();
        if n == 0 {
            return Ok(vec![]);
        }
        let active: Vec<usize> = (0..n).filter(|&i| rms[i] >= rms_floor).collect();
        let frames: Vec<[f32; WINDOW]> = active.iter().map(|&i| frames[i]).collect();

        // Frames are independent, so batches run in parallel: split the batch
        // list into one contiguous chunk per core and decode in place.
        let mut decoded = vec![(0.0f32, 0.0f32); frames.len()];
        let threads = std::thread::available_parallelism().map_or(1, |p| p.get());
        let per_thread = n.div_ceil(BATCH).div_ceil(threads) * BATCH;
        std::thread::scope(|s| {
            let jobs: Vec<_> = frames
                .chunks(per_thread)
                .zip(decoded.chunks_mut(per_thread))
                .map(|(fr, out)| s.spawn(move || self.run_batches(fr, out)))
                .collect();
            jobs.into_iter()
                .try_for_each(|j| j.join().expect("pitch worker panicked"))
        })?;

        let mut all = vec![(0.0f32, 0.0f32); n];
        for (&i, d) in active.iter().zip(decoded) {
            all[i] = d;
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

/// Frame 16 kHz mono audio into normalized 1024-sample frames (centered, 10 ms
/// hop), plus each frame's RMS before normalization.
fn frame_and_normalize(audio16: &[f32]) -> (Vec<[f32; WINDOW]>, Vec<f32>) {
    let pad = WINDOW / 2;
    // Center padding (zeros), matching torch F.pad.
    let mut padded = vec![0.0f32; audio16.len() + 2 * pad];
    padded[pad..pad + audio16.len()].copy_from_slice(audio16);

    if padded.len() < WINDOW {
        return (vec![], vec![]);
    }
    let n_frames = (padded.len() - WINDOW) / HOP + 1;
    let mut frames = Vec::with_capacity(n_frames);
    let mut rms = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let start = f * HOP;
        let mut frame = [0.0f32; WINDOW];
        frame.copy_from_slice(&padded[start..start + WINDOW]);
        rms.push((frame.iter().map(|s| s * s).sum::<f32>() / WINDOW as f32).sqrt());
        // per-frame mean/std normalization
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
        frames.push(frame);
    }
    (frames, rms)
}
