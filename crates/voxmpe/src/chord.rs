//! Microtonal chord generation — the resolved "centerpiece" model.
//!
//! Routing (see MICROTONAL_SPEC.md "Chord semantics"):
//! - A **mode** carries harmony in its degree layout -> stack degrees `i, i+2, i+4`
//!   (ordinal). Always in-scale, always defined.
//! - An **equal division** has no built-in chord tones -> aim at tuning-native ratio
//!   targets and snap each to the nearest degree (ratio-snap).
//!
//! Either way, the result is scored by BEAT RATE (coincident-partial wobble). If the
//! best achievable triad beats harder than the guard threshold, we degrade to the
//! least-beating dyad and flag it — "no stable triad here" is a number, not a shrug.

use crate::scala::{KindSource, Scale, ScaleKind};
use voxmpe_core::interval::{cents_to_freq, ratio_to_cents};

/// "No stable triad" guard, in CENTS of deviation from the tuning-native ratio
/// target. Register-independent (unlike beat Hz), so it keeps 12-TET's ~14c-off
/// third (a real triad that merely beats) while rejecting octave ratios forced
/// onto Bohlen–Pierce (~53c off). Only applied on the ratio-snap path — a mode's
/// own degrees define its triad and are trusted as-is.
pub const NO_TRIAD_MAX_CENTS: f64 = 35.0;

/// A reference beat threshold (Hz) used only as an ear-training DIAGNOSTIC, not as
/// the guard. Beat rate is register-dependent, which is exactly why the guard above
/// is in cents; this constant just anchors "audibly beating" for reporting.
pub const NO_TRIAD_BEAT_HZ: f64 = 9.0;

/// Snap a target interval (cents above the root) to the nearest scale degree,
/// searching degrees across a couple of periods so wide targets still land.
pub fn snap_interval(target_cents: f64, degrees: &[f64], period: f64) -> f64 {
    let mut best = degrees[0];
    let mut best_err = f64::MAX;
    for k in 0..=2 {
        for &d in degrees {
            let cand = d + k as f64 * period;
            let err = (cand - target_cents).abs();
            if err < best_err {
                best_err = err;
                best = cand;
            }
        }
    }
    best
}

/// Beating between the root and an interval, modeled as the wobble of the coincident
/// partials of ratio `n/d` (major third = 5/4 -> harmonics 5 and 4). Zero when the
/// interval is exactly `n/d`; grows as it is detuned.
pub fn beat_at_ratio(root_hz: f64, interval_cents: f64, n: f64, d: f64) -> f64 {
    let f = cents_to_freq(interval_cents, root_hz);
    (n * root_hz - d * f).abs()
}

/// Canonical guard input: the major third's 5:4 beat above `root_hz`.
pub fn major_third_beat_hz(root_hz: f64, third_cents: f64) -> f64 {
    beat_at_ratio(root_hz, third_cents, 5.0, 4.0)
}

/// Tuning-native major-triad targets (cents above root), chosen by period family.
/// Octave -> 5/4 & 3/2; 3:1 tritave (Bohlen–Pierce) -> 5/3 & 7/3 (the 3:5:7 chord).
fn major_targets(period: f64) -> Option<(f64, f64)> {
    let octave = 1200.0;
    let tritave = ratio_to_cents(3.0); // 1901.955
    if (period - octave).abs() < 50.0 {
        Some((ratio_to_cents(5.0 / 4.0), ratio_to_cents(3.0 / 2.0)))
    } else if (period - tritave).abs() < 50.0 {
        Some((ratio_to_cents(5.0 / 3.0), ratio_to_cents(7.0 / 3.0)))
    } else {
        None
    }
}

/// Harmonic pair used to score each target's beating (numerator, denominator).
fn target_harmonics(period: f64) -> ((f64, f64), (f64, f64)) {
    let tritave = ratio_to_cents(3.0);
    if (period - tritave).abs() < 50.0 {
        ((5.0, 3.0), (7.0, 3.0)) // BP 5/3, 7/3
    } else {
        ((5.0, 4.0), (3.0, 2.0)) // octave 5/4, 3/2
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Method {
    Ordinal,
    RatioSnap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Triad,
    DegradedToDyad,
}

#[derive(Debug, Clone, Copy)]
pub struct ChordTone {
    /// Interval above the root, in cents.
    pub cents_above_root: f64,
    /// Distance from the ideal ratio target, in cents (0 for the root; for ordinal,
    /// distance from the nearest tuning-native target if one exists).
    pub snap_error_cents: f64,
    /// This tone's beating against the root, in Hz.
    pub beat_hz: f64,
}

#[derive(Debug, Clone)]
pub struct Chord {
    pub method: Method,
    pub kind_source: KindSource,
    pub tones: Vec<ChordTone>,
    pub verdict: Verdict,
}

/// Generate a major triad rooted at scale degree `root_idx`, sounded from `root_hz`.
///
/// Routes on the scale's classification, scores the result by beat rate, and degrades
/// to the least-beating dyad (flagging [`Verdict::DegradedToDyad`]) when no consonant
/// triad is achievable — e.g. octave ratios forced onto Bohlen–Pierce.
pub fn generate_major_triad(
    scale: &Scale,
    root_idx: usize,
    root_hz: f64,
    guard_cents: f64,
) -> Chord {
    let (kind, kind_source) = scale.classify();
    let n = scale.degrees.len();
    let ((tn, td), (fn_, fd)) = target_harmonics(scale.period);

    // Third and fifth intervals above the root, per routing.
    let (third_c, fifth_c) = match kind {
        ScaleKind::Mode => {
            // Ordinal: stack degrees i, i+2, i+4 with period wrap.
            let degree_at =
                |j: usize| -> f64 { scale.degrees[j % n] + (j / n) as f64 * scale.period };
            let base = degree_at(root_idx);
            (
                degree_at(root_idx + 2) - base,
                degree_at(root_idx + 4) - base,
            )
        }
        ScaleKind::EqualDivision => {
            // Ratio-snap: aim at tuning-native targets, snap to nearest degree.
            let (t, f) = major_targets(scale.period)
                .unwrap_or((ratio_to_cents(5.0 / 4.0), ratio_to_cents(3.0 / 2.0)));
            (
                snap_interval(t, &scale.degrees, scale.period),
                snap_interval(f, &scale.degrees, scale.period),
            )
        }
    };

    // Informational snap error vs the nearest tuning-native target (if any).
    let (ideal_t, ideal_f) = major_targets(scale.period).unwrap_or((third_c, fifth_c));
    let third = ChordTone {
        cents_above_root: third_c,
        snap_error_cents: third_c - ideal_t,
        beat_hz: beat_at_ratio(root_hz, third_c, tn, td),
    };
    let fifth = ChordTone {
        cents_above_root: fifth_c,
        snap_error_cents: fifth_c - ideal_f,
        beat_hz: beat_at_ratio(root_hz, fifth_c, fn_, fd),
    };
    let root = ChordTone {
        cents_above_root: 0.0,
        snap_error_cents: 0.0,
        beat_hz: 0.0,
    };

    let method = match kind {
        ScaleKind::Mode => Method::Ordinal,
        ScaleKind::EqualDivision => Method::RatioSnap,
    };

    // A mode's own degrees define its triad — trust them (a deliberately neutral
    // third is still that mode's third). On the ratio-snap path we DID aim at a
    // ratio, so we can judge the miss: a triad only if BOTH upper tones land within
    // the cents guard. Otherwise degrade to the root plus the least-off dyad.
    let is_triad = match kind {
        ScaleKind::Mode => true,
        ScaleKind::EqualDivision => {
            third.snap_error_cents.abs() <= guard_cents
                && fifth.snap_error_cents.abs() <= guard_cents
        }
    };

    if is_triad {
        Chord {
            method,
            kind_source,
            tones: vec![root, third, fifth],
            verdict: Verdict::Triad,
        }
    } else {
        let partner = if third.snap_error_cents.abs() <= fifth.snap_error_cents.abs() {
            third
        } else {
            fifth
        };
        Chord {
            method,
            kind_source,
            tones: vec![root, partner],
            verdict: Verdict::DegradedToDyad,
        }
    }
}
