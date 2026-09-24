//! Retune a `voxmpe-core` analysis to an arbitrary tuning: the piece that unites
//! microtonal quantization with the voice's expressive continuous bend.
//!
//! Each note's *center* is snapped to a scale degree (via [`Tuning`]), while the
//! singer's vibrato/scoops around that center are preserved: the whole bend curve is
//! shifted by one constant so it now deviates from the retuned center instead of the
//! 12-TET one. When a note has no captured curve, a single static tuning bend is
//! injected so the retuning still sounds. The result is a plain `Analysis` that the
//! shared [`voxmpe_core::smf::write_smf`] serializes unchanged.

use crate::quantize::Tuning;
use voxmpe_core::types::{Analysis, CurvePoint, Note};

/// Retune every note of `analysis` to `tuning`. Frames and timing are untouched.
pub fn retune(analysis: &Analysis, tuning: &Tuning) -> Analysis {
    Analysis {
        frames: analysis.frames.clone(),
        notes: analysis
            .notes
            .iter()
            .map(|n| retune_note(n, tuning))
            .collect(),
        hop_s: analysis.hop_s,
    }
}

fn retune_note(n: &Note, t: &Tuning) -> Note {
    // Retuned note center, as a fractional MIDI note, then its nearest MIDI key.
    let center = t.snap_to_semitones(n.pitch_center);
    let new_pitch = center.round().clamp(0.0, 127.0) as u8;

    // The bend curve stores deviation from the OLD `pitch`, and the singer's vibrato
    // is deviation from `pitch_center`. Retuning to `center` on `new_pitch` shifts
    // every sample by this constant; per-sample variation (vibrato) is preserved.
    let static_offset = center - new_pitch as f64; // scale degree vs its MIDI key
    let shift = static_offset + (n.pitch as f64 - n.pitch_center);

    let mut bend: Vec<CurvePoint> = n
        .bend
        .iter()
        .map(|p| CurvePoint {
            time: p.time,
            value: p.value + shift as f32,
        })
        .collect();
    if bend.is_empty() {
        // No expression captured: still apply the static tuning offset at note start.
        bend.push(CurvePoint {
            time: n.start,
            value: static_offset as f32,
        });
    }

    Note {
        pitch: new_pitch,
        bend,
        ..n.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scala::Scale;

    const MIDDLE_C: f64 = 261.625565;

    const SCL_12TET: &str = "! t\n12-TET\n 12\n 100.\n 200.\n 300.\n 400.\n 500.\n 600.\n 700.\n 800.\n 900.\n 1000.\n 1100.\n 2/1\n";
    const SCL_JI: &str = "! t\nJI\n 7\n 9/8\n 5/4\n 4/3\n 3/2\n 5/3\n 15/8\n 2/1\n";

    fn note(pitch: u8, center: f64, bend: Vec<CurvePoint>) -> Note {
        Note {
            pitch,
            pitch_center: center,
            start: 0.0,
            end: 1.0,
            velocity: 0.8,
            bend,
            amplitude: vec![],
            pressure: vec![],
            slide: vec![],
        }
    }

    fn one(analysis_note: Note) -> Analysis {
        Analysis {
            frames: vec![],
            notes: vec![analysis_note],
            hop_s: 0.01,
        }
    }

    #[test]
    fn twelve_tet_pulls_a_sharp_a_to_concert_pitch() {
        // Steady 30-cent-sharp A4 (pitch 69, bend ~+0.3). 12-TET retune -> pitch 69,
        // bend collapses toward 0 (the sharpness is corrected to 440).
        let t = Tuning::new(&Scale::parse(SCL_12TET).unwrap(), MIDDLE_C);
        let out = retune(
            &one(note(
                69,
                69.3,
                vec![CurvePoint {
                    time: 0.0,
                    value: 0.3,
                }],
            )),
            &t,
        );
        assert_eq!(out.notes[0].pitch, 69);
        assert!(
            out.notes[0].bend[0].value.abs() < 0.01,
            "got {}",
            out.notes[0].bend[0].value
        );
    }

    #[test]
    fn ji_retunes_a_near_e_to_the_pure_third_with_flat_bend() {
        // Near-E center (64.2) -> JI third: pitch 64, static bend ~-0.137 semitones.
        let t = Tuning::new(&Scale::parse(SCL_JI).unwrap(), MIDDLE_C);
        let out = retune(
            &one(note(
                64,
                64.2,
                vec![CurvePoint {
                    time: 0.0,
                    value: 0.2,
                }],
            )),
            &t,
        );
        assert_eq!(out.notes[0].pitch, 64);
        assert!(
            (out.notes[0].bend[0].value - (-0.137)).abs() < 0.01,
            "got {}",
            out.notes[0].bend[0].value
        );
    }

    #[test]
    fn vibrato_is_preserved_across_retuning() {
        // Two samples differing by 0.1 semitone (vibrato) must still differ by 0.1
        // after retuning: only the constant offset changes, not the wiggle.
        let t = Tuning::new(&Scale::parse(SCL_JI).unwrap(), MIDDLE_C);
        let b = vec![
            CurvePoint {
                time: 0.0,
                value: 0.15,
            },
            CurvePoint {
                time: 0.5,
                value: 0.25,
            },
        ];
        let out = retune(&one(note(64, 64.2, b)), &t);
        let d = out.notes[0].bend[1].value - out.notes[0].bend[0].value;
        assert!((d - 0.1).abs() < 1e-5, "vibrato depth changed: {d}");
    }

    #[test]
    fn empty_curve_still_gets_a_static_tuning_bend() {
        let t = Tuning::new(&Scale::parse(SCL_JI).unwrap(), MIDDLE_C);
        let out = retune(&one(note(64, 64.2, vec![])), &t);
        assert_eq!(out.notes[0].bend.len(), 1);
        assert!((out.notes[0].bend[0].value - (-0.137)).abs() < 0.01);
    }
}
