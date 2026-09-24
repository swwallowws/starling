//! Shaping the pitch curves of retuned notes, so a take does not have to be sung
//! perfectly: smoothing, correction toward the scale note, and vibrato depth.
//! Runs after `retune`, before preview and export, so what you hear is what you get.

use voxmpe_core::types::{Analysis, CurvePoint};

use crate::quantize::Tuning;

/// How the pitch curve inside each note is reshaped. The identity is
/// `smoothing 0, correction 0, vibrato 1`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    /// 0..1: low-pass the whole curve (jitter, then vibrato at high values).
    pub smoothing: f32,
    /// 0..1: remove slow movement (scoops, drift) toward the scale note.
    pub correction: f32,
    /// 0..1.5: scale the fast movement (vibrato).
    pub vibrato: f32,
}

impl Shape {
    pub fn is_identity(&self) -> bool {
        self.smoothing == 0.0 && self.correction == 0.0 && (self.vibrato - 1.0).abs() < 1e-6
    }
}

/// Time constant (s) of the smoothing low-pass at 100%.
const SMOOTH_TAU_MAX: f32 = 0.06;
/// Splits slow movement (scoops, drift) from vibrato (about 5 to 7 Hz).
const SLOW_TAU: f32 = 0.07;

/// Reshape every note's bend curve. `tuning` gives each note's scale pitch, so
/// correction pulls toward the scale note, not the nearest piano key.
pub fn shape(analysis: &mut Analysis, tuning: &Tuning, s: &Shape) {
    if s.is_identity() {
        return;
    }
    for n in &mut analysis.notes {
        let target = (tuning.snap_to_semitones(n.pitch_center) - n.pitch as f64) as f32;
        n.bend = shape_curve(&n.bend, target, s);
    }
}

/// Reshape one bend curve (semitones relative to the note's MIDI key) around
/// `target`, the scale pitch relative to that key.
pub fn shape_curve(bend: &[CurvePoint], target: f32, s: &Shape) -> Vec<CurvePoint> {
    if bend.len() < 2 || s.is_identity() {
        return bend.to_vec();
    }
    let times: Vec<f32> = bend.iter().map(|p| p.time).collect();
    let dev: Vec<f32> = bend.iter().map(|p| p.value - target).collect();
    let dev = if s.smoothing > 0.0 {
        lowpass(&times, &dev, s.smoothing * SMOOTH_TAU_MAX)
    } else {
        dev
    };
    let slow = lowpass(&times, &dev, SLOW_TAU);
    bend.iter()
        .zip(dev.iter().zip(&slow))
        .map(|(p, (d, sl))| CurvePoint {
            time: p.time,
            value: target + sl * (1.0 - s.correction) + (d - sl) * s.vibrato,
        })
        .collect()
}

/// Zero-phase one-pole low-pass (forward then backward) over irregularly timed points.
fn lowpass(times: &[f32], x: &[f32], tau: f32) -> Vec<f32> {
    let pass = |order: &mut dyn Iterator<Item = usize>, x: &[f32]| {
        let mut out = x.to_vec();
        let mut prev: Option<(f32, f32)> = None;
        for i in order {
            if let Some((pt, py)) = prev {
                let a = 1.0 - (-(times[i] - pt).abs() / tau).exp();
                out[i] = py + a * (x[i] - py);
            }
            prev = Some((times[i], out[i]));
        }
        out
    };
    let fwd = pass(&mut (0..x.len()), x);
    pass(&mut (0..x.len()).rev(), &fwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: Shape = Shape {
        smoothing: 0.0,
        correction: 0.0,
        vibrato: 1.0,
    };

    /// Points every 10 ms for `secs`, value = target + f(t).
    fn curve(secs: f32, target: f32, f: impl Fn(f32) -> f32) -> Vec<CurvePoint> {
        (0..(secs * 100.0) as usize)
            .map(|i| {
                let t = i as f32 * 0.01;
                CurvePoint {
                    time: t,
                    value: target + f(t),
                }
            })
            .collect()
    }

    /// Largest deviation from `target` in the middle half (away from edge effects).
    fn mid_dev(c: &[CurvePoint], target: f32) -> f32 {
        let n = c.len();
        c[n / 4..3 * n / 4]
            .iter()
            .fold(0.0f32, |m, p| m.max((p.value - target).abs()))
    }

    #[test]
    fn defaults_leave_the_curve_alone() {
        let c = curve(1.0, 0.3, |t| 0.2 * (t * 30.0).sin());
        assert_eq!(shape_curve(&c, 0.3, &ID), c);
    }

    #[test]
    fn full_correction_flattens_a_scoop_onto_the_scale_note() {
        let c = curve(1.0, 0.38, |t| 0.4 * (1.0 - t)); // slow drift down onto the note
        let out = shape_curve(
            &c,
            0.38,
            &Shape {
                correction: 1.0,
                ..ID
            },
        );
        assert!(mid_dev(&out, 0.38) < 0.03, "{}", mid_dev(&out, 0.38));
    }

    #[test]
    fn vibrato_zero_removes_vibrato_and_more_deepens_it() {
        let c = curve(2.0, 0.0, |t| {
            0.5 * (2.0 * std::f32::consts::PI * 6.0 * t).sin()
        });
        let none = shape_curve(&c, 0.0, &Shape { vibrato: 0.0, ..ID });
        assert!(mid_dev(&none, 0.0) < 0.12, "{}", mid_dev(&none, 0.0));
        let more = shape_curve(&c, 0.0, &Shape { vibrato: 1.5, ..ID });
        assert!(mid_dev(&more, 0.0) > 0.6, "{}", mid_dev(&more, 0.0));
    }

    #[test]
    fn smoothing_irons_out_jitter() {
        let c = curve(1.0, 0.0, |t| {
            if ((t * 100.0).round() as i32) % 2 == 0 {
                0.2
            } else {
                -0.2
            }
        });
        let out = shape_curve(
            &c,
            0.0,
            &Shape {
                smoothing: 1.0,
                ..ID
            },
        );
        assert!(mid_dev(&out, 0.0) < 0.05, "{}", mid_dev(&out, 0.0));
    }

    #[test]
    fn the_scale_offset_is_kept() {
        // 31-EDO style: the scale note sits 0.38 semitones above its MIDI key.
        let c = curve(0.5, 0.38, |_| 0.0);
        let out = shape_curve(
            &c,
            0.38,
            &Shape {
                smoothing: 0.5,
                correction: 1.0,
                vibrato: 0.0,
            },
        );
        assert!(out.iter().all(|p| (p.value - 0.38).abs() < 1e-4));
    }

    #[test]
    fn short_curves_are_left_alone() {
        let c = vec![CurvePoint {
            time: 0.0,
            value: 0.25,
        }];
        assert_eq!(
            shape_curve(
                &c,
                0.25,
                &Shape {
                    correction: 1.0,
                    ..ID
                }
            ),
            c
        );
    }
}
