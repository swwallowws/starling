//! Expression encoding (SPEC §5.5, §6): turn per-frame residual pitch and
//! amplitude into per-note bend + CC curves and an attack velocity. Output is
//! MIDI-agnostic (semitones / normalized 0..1); MPE scaling happens at write.

use crate::config::ExpressionConfig;
use crate::segment::{hz_to_semitones, Span};
use crate::types::{CurvePoint, Frame, Note};

/// Build a [`Note`] for `span` with quantized `pitch` (12-TET) and its
/// `pitch_center` (fractional semitones — THE SEAM, preserved verbatim on the
/// [`Note`] so a microtonal consumer can requantize). `max_rms` is the global
/// amplitude reference for normalizing dynamics across the whole performance.
pub fn encode_note(
    frames: &[Frame],
    span: Span,
    pitch: u8,
    pitch_center: f64,
    max_rms: f32,
    hop_s: f32,
    cfg: &ExpressionConfig,
) -> Note {
    let inv_max = if max_rms > 1e-9 { 1.0 / max_rms } else { 0.0 };

    // Bend curve: raw (unfiltered) residual = f0_in_semitones - pitch. Residual
    // is relative to the 12-TET `pitch` so the `smf` writer's ±range scaling is
    // correct; a microtonal consumer recomputes its own residual from
    // `pitch_center` + the frame contour.
    let mut bend_raw = Vec::new();
    let mut amp_raw = Vec::new();
    for f in &frames[span.start..span.end] {
        let semis = if f.f0_hz > 0.0 {
            hz_to_semitones(f.f0_hz) - pitch as f32
        } else {
            // unvoiced micro-gap inside a note: hold previous bend
            bend_raw.last().map(|p: &CurvePoint| p.value).unwrap_or(0.0)
        };
        bend_raw.push(CurvePoint {
            time: f.time,
            value: semis,
        });
        amp_raw.push(CurvePoint {
            time: f.time,
            value: (f.rms * inv_max).clamp(0.0, 1.0),
        });
    }

    let bend = thin(&bend_raw, cfg.bend_thin_semitones);
    let amplitude = thin(&amp_raw, cfg.amp_thin);

    // Velocity from the attack: peak normalized amplitude in the first ~30 ms.
    let attack_n = amp_raw.len().clamp(1, 3);
    let attack_peak = amp_raw[..attack_n]
        .iter()
        .map(|p| p.value)
        .fold(0.0f32, f32::max);
    let velocity =
        (attack_peak.powf(cfg.velocity_gamma)).clamp(0.0, 1.0).max(cfg.velocity_floor);

    Note {
        pitch,
        pitch_center,
        start: frames[span.start].time,
        end: frames[span.end - 1].time + hop_s,
        velocity,
        bend,
        amplitude,
        // Reserved MPE dimensions, not yet derived from the voice (SPEC §6).
        pressure: Vec::new(),
        slide: Vec::new(),
    }
}

/// Perceptual thinning: keep first/last and any point differing from the last
/// emitted by at least `eps`. Keeps vibrato detail, drops near-duplicates.
fn thin(points: &[CurvePoint], eps: f32) -> Vec<CurvePoint> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut out = vec![points[0]];
    for p in &points[1..points.len() - 1] {
        if (p.value - out.last().unwrap().value).abs() >= eps {
            out.push(*p);
        }
    }
    out.push(points[points.len() - 1]);
    out
}
