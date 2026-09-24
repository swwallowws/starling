//! Shared voice-to-MPE-MIDI core.
//!
//! Tuning-agnostic primitives + the offline monophonic singing-voice -> expressive
//! MIDI analysis pipeline, reused across the Playground's voice→MIDI tools
//! (`singmidi`, `microtonal-aud2midi`). "Correct" for the primitive layer is a
//! NUMBER — every function is verified numerically, no ear required.
//!
//! Layers:
//! - [`interval`] — cents ↔ ratio ↔ frequency math.
//! - [`mpe`] — the freq → (MIDI note, 14-bit pitch bend) primitive and encoder.
//! - [`pitch`] — CREPE pitch tracking (tract-onnx).
//! - [`features`] — per-frame RMS + spectral centroid.
//! - [`segment`] — note segmentation from the pitch contour.
//! - [`expression`] — per-note bend/amplitude curves + velocity.
//! - [`smf`] — MPE Standard MIDI File serializer.
//! - [`config`] / [`types`] / [`resample`] — parameters, data types, resampling.
//!
//! THE SEAM — note SELECTION is intentionally NOT baked into the engine. Turning a
//! fractional pitch into a scale note is where consumers diverge (`singmidi` rounds
//! to 12-TET; `microtonal-aud2midi` quantizes to a scale degree). So [`segment::span_pitch`]
//! returns the RAW **fractional** center (f64 semitones) and [`types::Note`] carries
//! it verbatim as [`types::Note::pitch_center`]; the 12-TET convenience note lives in
//! [`types::Note::pitch`] via [`segment::round_to_12tet`]. Downstream consumers read
//! `pitch_center` and quantize to their own tuning — the fraction is never discarded.

pub mod config;
pub mod expression;
pub mod features;
pub mod interval;
pub mod mpe;
pub mod pitch;
pub mod resample;
pub mod segment;
pub mod smf;
pub mod types;

pub use config::{AnalysisConfig, ExpressionConfig, SegmentationConfig};
pub use pitch::CrepeModel;
pub use types::{Analysis, CurvePoint, Frame, Note};

use anyhow::Result;

/// Output of the slow stage ([`track`]): every analysis frame plus the hop size.
/// Keep it to re-run [`transcribe`] with other settings without re-running CREPE.
///
/// `voiced` reflects the cfg passed to [`track`]. [`transcribe`] recomputes it
/// from its own cfg.
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
///
/// May use a higher `rms_floor` than [`track`] did, but not a lower one:
/// frames below track()'s floor were never analyzed (confidence 0), so
/// re-run [`track`] to lower it.
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
            expression::encode_note(
                &frames,
                span,
                pitch,
                center,
                max_rms,
                hop_s,
                &cfg.expression,
            )
        })
        .collect();

    Analysis {
        frames,
        notes,
        hop_s,
    }
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
