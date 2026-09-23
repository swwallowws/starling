//! Per-frame audio features aligned to the pitch frames (10 ms hop @ 16 kHz):
//! RMS amplitude (dynamics) and spectral centroid (timbre, optional downstream).

use realfft::RealFftPlanner;

use crate::pitch::{CREPE_SR, HOP, WINDOW};
use crate::resample::resample;

#[derive(Debug, Clone, Copy)]
pub struct FrameFeature {
    pub rms: f32,
    pub centroid_hz: f32,
}

/// Compute RMS + spectral centroid per frame, aligned 1:1 with [`crate::pitch::CrepeModel::track`]
/// (same 16 kHz resample, centered framing, 1024 window, 160 hop).
pub fn extract(audio: &[f32], sample_rate: u32, n_frames: usize) -> Vec<FrameFeature> {
    let audio16 = resample(audio, sample_rate, CREPE_SR);
    let pad = WINDOW / 2;
    let mut padded = vec![0.0f32; audio16.len() + 2 * pad];
    padded[pad..pad + audio16.len()].copy_from_slice(&audio16);

    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(WINDOW);
    let mut scratch = fft.make_output_vec();

    // Hann window for the spectral estimate.
    let hann: Vec<f32> = (0..WINDOW)
        .map(|i| {
            let x = std::f32::consts::PI * i as f32 / (WINDOW as f32 - 1.0);
            x.sin().powi(2)
        })
        .collect();

    let bin_hz = CREPE_SR as f32 / WINDOW as f32;

    let mut out = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let start = f * HOP;
        if start + WINDOW > padded.len() {
            out.push(FrameFeature {
                rms: 0.0,
                centroid_hz: 0.0,
            });
            continue;
        }
        let frame = &padded[start..start + WINDOW];

        // RMS on the raw (unwindowed) frame.
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / WINDOW as f32).sqrt();

        // Spectral centroid on the windowed frame.
        let mut windowed: Vec<f32> = frame.iter().zip(&hann).map(|(s, w)| s * w).collect();
        fft.process(&mut windowed, &mut scratch).unwrap();
        let mut mag_sum = 0.0f32;
        let mut weighted = 0.0f32;
        for (k, c) in scratch.iter().enumerate() {
            let mag = c.norm();
            mag_sum += mag;
            weighted += mag * (k as f32 * bin_hz);
        }
        let centroid_hz = if mag_sum > 1e-9 {
            weighted / mag_sum
        } else {
            0.0
        };

        out.push(FrameFeature { rms, centroid_hz });
    }
    out
}
