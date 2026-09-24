//! Band-limited resampling to CREPE's 16 kHz rate.
//!
//! Uses a windowed-sinc (Blackman) kernel with the cutoff pinned to the lower
//! of the two Nyquists, so downsampling (the common 44.1/48k -> 16k case) is
//! anti-aliased rather than naively decimated.

const ZERO_CROSSINGS: usize = 16;

fn sinc(x: f32) -> f32 {
    if x.abs() < 1e-8 {
        1.0
    } else {
        let px = std::f32::consts::PI * x;
        px.sin() / px
    }
}

fn blackman(n: f32, width: f32) -> f32 {
    // n in [-width, width]; standard Blackman over [0, 2*width]
    let t = (n + width) / (2.0 * width);
    0.42 - 0.5 * (2.0 * std::f32::consts::PI * t).cos()
        + 0.08 * (4.0 * std::f32::consts::PI * t).cos()
}

/// Resample mono `input` from `in_rate` to `out_rate`.
#[allow(clippy::needless_range_loop)] // index is the sample position used in the kernel
pub fn resample(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if in_rate == out_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = out_rate as f32 / in_rate as f32;
    // Normalized cutoff in input-sample units (1.0 == input Nyquist).
    let fc = 0.5 * ratio.min(1.0);
    // Kernel half-width in input samples.
    let half = ZERO_CROSSINGS as f32 / (2.0 * fc);

    let out_len = ((input.len() as f32) * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);

    for m in 0..out_len {
        let center = m as f32 / ratio; // position in input samples
        let lo = (center - half).floor().max(0.0) as usize;
        let hi = ((center + half).ceil() as usize).min(input.len().saturating_sub(1));
        let mut acc = 0.0f32;
        let mut norm = 0.0f32;
        for n in lo..=hi {
            let x = n as f32 - center;
            if x.abs() > half {
                continue;
            }
            let w = 2.0 * fc * sinc(2.0 * fc * x) * blackman(x, half);
            acc += input[n] * w;
            norm += w;
        }
        out.push(if norm.abs() > 1e-8 { acc / norm } else { 0.0 });
    }
    out
}
