//! Note segmentation — the core problem (SPEC §5).
//!
//! CREPE gives a pitch *contour*, not note boundaries. We derive boundaries
//! from three cues and resolve them into segments:
//!   1. voicing gaps   (hard boundaries)
//!   2. pitch-stability breaks  (contour moves to a new center and *holds*)
//!   3. amplitude onsets        (re-articulation of the same pitch)
//!
//! The discriminator between vibrato and a real note change is **how long a new
//! center holds** (`hold_time_ms`): vibrato never settles, a new note does.

use crate::config::SegmentationConfig;
use crate::types::Frame;

/// A contiguous note span as half-open frame indices `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// Hz -> fractional MIDI note number (semitones). Expressed via the shared
/// [`crate::interval`] cents math so there is one ratio-to-cents code path.
#[inline]
pub fn hz_to_semitones(hz: f32) -> f32 {
    (69.0 + crate::interval::ratio_to_cents((hz / 440.0) as f64) / 100.0) as f32
}

fn median(vals: &[f32]) -> f32 {
    if vals.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f32> = vals.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = v.len() / 2;
    if v.len().is_multiple_of(2) {
        0.5 * (v[m - 1] + v[m])
    } else {
        v[m]
    }
}

/// Median of the values within `tol` of the overall median — i.e. the dominant
/// cluster, ignoring a leading scoop / transient outliers.
fn robust_center(vals: &[f32], tol: f32) -> f32 {
    if vals.is_empty() {
        return 0.0;
    }
    let m = median(vals);
    let cluster: Vec<f32> = vals
        .iter()
        .copied()
        .filter(|v| (v - m).abs() <= tol)
        .collect();
    if cluster.is_empty() {
        m
    } else {
        median(&cluster)
    }
}

fn std_dev(vals: &[f32]) -> f32 {
    if vals.len() < 2 {
        return 0.0;
    }
    let mean = vals.iter().sum::<f32>() / vals.len() as f32;
    let var = vals.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / vals.len() as f32;
    var.sqrt()
}

/// Median-filter a slice (odd-ish window); returns same-length output.
fn median_filter(x: &[f32], w: usize) -> Vec<f32> {
    if w <= 1 {
        return x.to_vec();
    }
    let half = w / 2;
    let n = x.len();
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half + 1).min(n);
            median(&x[lo..hi])
        })
        .collect()
}

#[inline]
fn ms_to_frames(ms: f32, hop_s: f32) -> usize {
    (ms / 1000.0 / hop_s).round().max(1.0) as usize
}

/// Segment the analysis frames into note spans.
pub fn segment(frames: &[Frame], hop_s: f32, cfg: &SegmentationConfig) -> Vec<Span> {
    let n = frames.len();
    if n == 0 {
        return vec![];
    }

    // Semitone contour (only meaningful where voiced); median-filtered copy for
    // segmentation decisions (the raw f0 is kept elsewhere for the bend curve).
    let st: Vec<f32> = frames
        .iter()
        .map(|f| {
            if f.voiced && f.f0_hz > 0.0 {
                hz_to_semitones(f.f0_hz)
            } else {
                f32::NAN
            }
        })
        .collect();
    // Fill unvoiced gaps with nearest voiced value so the median filter behaves,
    // then filter. (Unvoiced frames are excluded from runs anyway.)
    let filled = fill_nan(&st);
    let stf = median_filter(&filled, cfg.median_filter_frames);
    let rms: Vec<f32> = frames.iter().map(|f| f.rms).collect();

    let gap_frames = ms_to_frames(cfg.voicing_gap_ms, hop_s);
    let runs = voiced_runs(frames, gap_frames);

    let mut spans = Vec::new();
    for (a, b) in runs {
        segment_run(a, b, &stf, &rms, hop_s, cfg, &mut spans);
    }
    spans
}

/// Replace NaN runs with the nearest finite neighbor (forward then backward fill).
fn fill_nan(x: &[f32]) -> Vec<f32> {
    let mut out = x.to_vec();
    let mut last = 0.0f32;
    let mut seen = false;
    for v in out.iter_mut() {
        if v.is_finite() {
            last = *v;
            seen = true;
        } else if seen {
            *v = last;
        } else {
            *v = 0.0;
        }
    }
    out
}

/// Maximal voiced runs, tolerating unvoiced gaps shorter than `gap_frames`.
fn voiced_runs(frames: &[Frame], gap_frames: usize) -> Vec<(usize, usize)> {
    let n = frames.len();
    let mut runs = Vec::new();
    let mut i = 0;
    while i < n {
        if !frames[i].voiced {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        let mut last_voiced = i;
        loop {
            while j < n && frames[j].voiced {
                last_voiced = j;
                j += 1;
            }
            let gap_start = j;
            while j < n && !frames[j].voiced {
                j += 1;
            }
            let gap_len = j - gap_start;
            if j >= n || gap_len >= gap_frames {
                runs.push((start, last_voiced + 1));
                i = j;
                break;
            }
            // short gap: absorb, keep extending
        }
    }
    runs
}

/// Segment a single voiced run `[a, b)` using stability-break + onset cues.
fn segment_run(
    a: usize,
    b: usize,
    stf: &[f32],
    rms: &[f32],
    hop_s: f32,
    cfg: &SegmentationConfig,
    out: &mut Vec<Span>,
) {
    let hold = ms_to_frames(cfg.hold_time_ms, hop_s);
    let min_run = ms_to_frames(cfg.min_voiced_run_ms, hop_s);
    let stability_st = cfg.stability_cents / 100.0;
    let split_st = cfg.split_cents / 100.0;
    let delta = cfg.onset_rms_delta;

    let mut raw = Vec::new();
    let mut start = a;
    // amplitude-onset state: a re-articulation is a real dip below the note's
    // peak followed by recovery — distinct from the initial attack ramp.
    let mut peak = rms[a];
    let mut armed = false;
    let mut trough = rms[a];

    let mut k = a + 1;
    while k < b {
        let len = k - start;
        let mut boundary = false;

        // (cue 2) pitch-stability break: a forward window that has moved to a new
        // center *and* is itself settled. Require the current note to have held
        // for `hold` first so its center is established (not an attack transient),
        // and use a robust center so a leading scoop doesn't corrupt it.
        if len >= hold {
            let center = robust_center(&stf[start..k], stability_st);
            let fw_end = (k + hold).min(b);
            if fw_end - k >= min_run {
                let fw = &stf[k..fw_end];
                if (median(fw) - center).abs() >= split_st && std_dev(fw) <= stability_st {
                    boundary = true;
                }
            }
        }

        // (cue 3) amplitude onset: dip-armed re-articulation of the same pitch.
        peak = peak.max(rms[k]);
        if !armed && peak > cfg.rms_floor * 2.0 && rms[k] < peak / (1.0 + delta) {
            armed = true;
            trough = rms[k];
        }
        if armed {
            trough = trough.min(rms[k]);
            if len >= min_run
                && rms[k] > trough * (1.0 + delta)
                && rms[k] > cfg.rms_floor * 2.0
                && rms[k] > rms[k - 1]
            {
                boundary = true;
            }
        }

        if boundary {
            raw.push(Span { start, end: k });
            start = k;
            peak = rms[k];
            armed = false;
            trough = rms[k];
        }
        k += 1;
    }
    raw.push(Span { start, end: b });

    // Drop/merge sub-minimum segments into the previous span.
    for span in raw {
        if span.end - span.start < min_run {
            if let Some(prev) = out.last_mut() {
                if prev.end == span.start {
                    prev.end = span.end;
                    continue;
                }
            }
            // no mergeable neighbor and too short -> drop
            continue;
        }
        out.push(span);
    }
}

/// **THE SEAM** (SPEC §5.4). Fractional pitch center for a span, in semitones
/// (MIDI note-number space) — the median over the span's *stable* portion
/// (frames near the overall median), so a leading scoop doesn't drag the
/// estimate. Returns the RAW fractional value and does NOT round to any scale:
/// keeping the fraction is what lets a downstream consumer quantize to a
/// non-12-TET scale. For the 12-TET path, pass the result through
/// [`round_to_12tet`].
pub fn span_pitch(frames: &[Frame], span: Span, cfg: &SegmentationConfig) -> f64 {
    let sts: Vec<f32> = (span.start..span.end)
        .filter(|&i| frames[i].voiced && frames[i].f0_hz > 0.0)
        .map(|i| hz_to_semitones(frames[i].f0_hz))
        .collect();
    if sts.is_empty() {
        return 60.0;
    }
    robust_center(&sts, cfg.stability_cents / 100.0) as f64
}

/// Quantize a fractional pitch center (semitones) to a 12-TET MIDI note. The
/// 12-TET path only; microtonal consumers quantize [`span_pitch`]'s fractional
/// output to their own scale instead.
#[inline]
pub fn round_to_12tet(center: f64) -> u8 {
    center.round().clamp(0.0, 127.0) as u8
}
