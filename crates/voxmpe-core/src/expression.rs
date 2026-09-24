//! Expression encoding (SPEC §5.5, §6): turn per-frame residual pitch and
//! amplitude into per-note bend + CC curves and an attack velocity. Output is
//! MIDI-agnostic (semitones / normalized 0..1); MPE scaling happens at write.

use crate::config::ExpressionConfig;
use crate::segment::{hz_to_semitones, Span};
use crate::types::{CurvePoint, Frame, Note};

/// A frame whose pitch is further than this (semitones) from the note's center
/// is a misreading (octave error, breath), not expression.
const MAX_BEND_FROM_CENTER: f64 = 6.0;

/// Build a [`Note`] for `span` with quantized `pitch` (12-TET) and its
/// `pitch_center` (fractional semitones: THE SEAM, preserved verbatim on the
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
        // Follow only voiced frames within a plausible range of the note's own
        // center. Unvoiced frames inside a note (breaths, consonants) and
        // octave misreadings carry garbage pitch and would dive the bend.
        let st = hz_to_semitones(f.f0_hz);
        let plausible = (st as f64 - pitch_center).abs() <= MAX_BEND_FROM_CENTER;
        let semis = if f.voiced && f.f0_hz > 0.0 && plausible {
            st - pitch as f32
        } else {
            bend_raw
                .last()
                .map(|p: &CurvePoint| p.value)
                .unwrap_or((pitch_center - pitch as f64) as f32)
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
    let velocity = (attack_peak.powf(cfg.velocity_gamma))
        .clamp(0.0, 1.0)
        .max(cfg.velocity_floor);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(i: usize, f0_hz: f32, voiced: bool) -> Frame {
        Frame {
            time: i as f32 * 0.01,
            f0_hz,
            confidence: if voiced { 0.9 } else { 0.1 },
            rms: 0.1,
            centroid_hz: 0.0,
            voiced,
        }
    }

    /// A4 held, with an unvoiced breath (garbage low f0) and an octave-low
    /// misreading inside the note: neither may drag the bend curve.
    #[test]
    fn bend_ignores_unvoiced_frames_and_octave_errors() {
        let mut frames: Vec<Frame> = (0..40).map(|i| frame(i, 440.0, true)).collect();
        for f in &mut frames[18..22] {
            *f = frame(0, 60.0, false); // breath: CREPE guesses ~B1
        }
        frames[30].f0_hz = 220.0; // voiced, but an octave low
        for (i, f) in frames.iter_mut().enumerate() {
            f.time = i as f32 * 0.01;
        }
        let span = Span {
            start: 0,
            end: 40,
            cause: crate::segment::Cause::Voicing,
        };
        let note = encode_note(
            &frames,
            span,
            69,
            69.0,
            0.1,
            0.01,
            &ExpressionConfig::default(),
        );
        let worst = note.bend.iter().fold(0.0f32, |m, p| m.max(p.value.abs()));
        assert!(worst < 0.5, "bend dives {worst} semitones");
    }
}
