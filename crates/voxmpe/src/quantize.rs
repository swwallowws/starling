//! Scale quantization: the microtonal side of THE SEAM.
//!
//! `voxmpe-core` hands us each note's *fractional* MIDI pitch (`Note::pitch_center`,
//! semitones) and deliberately does NOT choose a note. Here we choose it against an
//! arbitrary tuning: snap the fractional pitch to the nearest scale-degree frequency,
//! then split that frequency into `(MIDI note, 14-bit bend)` via the shared primitive.
//!
//! Anchor discipline: a `.scl` is intervals only. A [`Tuning`] pins the 1/1 degree to a
//! concrete `anchor_hz`; keep it FIXED across every comparison (see MICROTONAL_SPEC.md).

use crate::scala::Scale;
use voxmpe_core::mpe::freq_to_note_and_bend;

/// A concrete tuning: a scale's degrees pinned to an anchor frequency for its 1/1.
#[derive(Debug, Clone)]
pub struct Tuning {
    /// Degrees within one period, cents, ascending, `[0] == 0.0` (the 1/1).
    degrees: Vec<f64>,
    /// Period in cents (1200 = octave, ~1902 = 3/1 tritave).
    period: f64,
    /// Frequency of the 1/1 degree.
    anchor_hz: f64,
}

impl Tuning {
    /// Pin `scale`'s 1/1 to `anchor_hz`. Common anchors: 261.625565 (middle C) or 440 (A4).
    pub fn new(scale: &Scale, anchor_hz: f64) -> Self {
        let mut degrees = scale.degrees.clone();
        degrees.sort_by(|a, b| a.partial_cmp(b).expect("finite cents"));
        Tuning {
            degrees,
            period: scale.period,
            anchor_hz,
        }
    }

    /// Snap an absolute frequency to the nearest scale-degree frequency, across all
    /// periods (octaves/tritaves). Nearest is measured in cents (perceptually even).
    pub fn snap_freq(&self, freq: f64) -> f64 {
        let cents = 1200.0 * (freq / self.anchor_hz).log2();
        let k = (cents / self.period).floor(); // which period the target sits in
        let reduced = cents - k * self.period; // fold into [0, period)

        let mut best = self.degrees[0];
        let mut best_err = (best - reduced).abs();
        for &d in &self.degrees {
            let err = (d - reduced).abs();
            if err < best_err {
                best_err = err;
                best = d;
            }
        }
        // The next period's 1/1 (== `period` cents) is also a candidate for a target
        // sitting just below the top of the period: otherwise we'd never snap up to it.
        if (self.period - reduced).abs() < best_err {
            best = self.period;
        }

        let snapped_cents = best + k * self.period;
        self.anchor_hz * 2f64.powf(snapped_cents / 1200.0)
    }

    /// Snap a fractional MIDI pitch to its scale degree, returned as a *fractional*
    /// MIDI note number (semitones). This is the retuned note center the expressive
    /// bend curve is rebuilt around (see [`crate::retune`]).
    pub fn snap_to_semitones(&self, midi_pitch_center: f64) -> f64 {
        let freq = 440.0 * 2f64.powf((midi_pitch_center - 69.0) / 12.0);
        let snapped = self.snap_freq(freq);
        69.0 + 12.0 * (snapped / 440.0).log2()
    }

    /// Quantize a fractional MIDI pitch (e.g. `voxmpe_core::Note::pitch_center`) to a
    /// scale degree and encode it as `(MIDI note, 14-bit pitch bend)`.
    pub fn quantize(&self, midi_pitch_center: f64, bend_range: f64) -> (u8, u16) {
        let freq = 440.0 * 2f64.powf((midi_pitch_center - 69.0) / 12.0);
        freq_to_note_and_bend(self.snap_freq(freq), bend_range)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use voxmpe_core::mpe::{bend_to_cents, MPE_BEND_RANGE};

    const MIDDLE_C: f64 = 261.625565;

    const SCL_12TET: &str = "\
! 12-tet.scl
12-TET
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

    const SCL_JI: &str = "\
! ji-major.scl
JI major
 7
 9/8
 5/4
 4/3
 3/2
 5/3
 15/8
 2/1
";

    #[test]
    fn twelve_tet_snaps_a_sharp_a4_back_to_concert_a() {
        // 1/1 = middle C; a sung A4 that's 30 cents sharp (pitch_center 69.3) must
        // snap to the 12-TET A (440 Hz) -> note 69, centered bend.
        let scale = Scale::parse(SCL_12TET).unwrap();
        let t = Tuning::new(&scale, MIDDLE_C);
        let (note, bend) = t.quantize(69.3, MPE_BEND_RANGE);
        assert_eq!(note, 69);
        assert_eq!(bend, 8192);
    }

    #[test]
    fn ji_major_snaps_a_near_e_to_the_pure_third() {
        // 1/1 = middle C. A sung note near E (pitch_center ~64.2) snaps to the JI
        // major third (5/4 above C) -> note 64 (E) bent ~-13.7 cents.
        let scale = Scale::parse(SCL_JI).unwrap();
        let t = Tuning::new(&scale, MIDDLE_C);
        let (note, bend) = t.quantize(64.2, MPE_BEND_RANGE);
        assert_eq!(note, 64);
        assert!((bend_to_cents(bend, MPE_BEND_RANGE) - (-13.69)).abs() < 0.6);
    }

    #[test]
    fn snapping_is_idempotent_on_exact_degrees() {
        // A frequency already ON a scale degree must snap to itself.
        let scale = Scale::parse(SCL_JI).unwrap();
        let t = Tuning::new(&scale, MIDDLE_C);
        let exact_fifth = MIDDLE_C * 1.5; // 3/2 above C
        assert!((t.snap_freq(exact_fifth) - exact_fifth).abs() < 1e-6);
    }
}
