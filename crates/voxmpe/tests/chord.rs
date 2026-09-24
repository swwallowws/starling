//! Layer-one numerical harness for microtonal CHORD generation.
//! Pins the reference table in MICROTONAL_SPEC.md ("Chord semantics"): the routing
//! model (mode -> ordinal, equal division -> ratio-snap) and the beat-rate guard.

use microtonal::chord::{
    generate_major_triad, major_third_beat_hz, snap_interval, Method, Verdict, NO_TRIAD_BEAT_HZ,
    NO_TRIAD_MAX_CENTS,
};
use microtonal::scala::Scale;
use voxmidi_core::interval::ratio_to_cents as cents;

const MIDDLE_C: f64 = 261.625565; // 1/1 anchor, fixed across every comparison

fn tet(n: usize) -> Vec<f64> {
    (0..n).map(|i| i as f64 * 1200.0 / n as f64).collect()
}
fn ji_major_mode() -> Vec<f64> {
    [1.0, 9.0 / 8.0, 5.0 / 4.0, 4.0 / 3.0, 3.0 / 2.0, 5.0 / 3.0, 15.0 / 8.0]
        .iter()
        .map(|&r| cents(r))
        .collect()
}
fn bohlen_pierce() -> Vec<f64> {
    let step = 1200.0 * 3f64.log2() / 13.0;
    (0..13).map(|i| i as f64 * step).collect()
}

fn ideal_third() -> f64 {
    cents(5.0 / 4.0)
}
fn ideal_fifth() -> f64 {
    cents(3.0 / 2.0)
}

// ===== Ratio-snap path: the spec reference table (low-level) ==========

#[test]
fn ji_major_snaps_to_a_pure_beatless_triad() {
    let s = ji_major_mode();
    let third = snap_interval(ideal_third(), &s, 1200.0);
    let fifth = snap_interval(ideal_fifth(), &s, 1200.0);
    assert!((third - 386.31).abs() < 0.1, "3rd {third}");
    assert!((fifth - 701.96).abs() < 0.1, "5th {fifth}");
    assert!(major_third_beat_hz(MIDDLE_C, third) < 0.1, "JI third must be beatless");
}

#[test]
fn tet31_third_is_near_pure_fifth_is_weaker() {
    let s = tet(31);
    let third = snap_interval(ideal_third(), &s, 1200.0);
    let fifth = snap_interval(ideal_fifth(), &s, 1200.0);
    assert!((third - ideal_third()).abs() < 1.0, "3rd err {third}");
    assert!(major_third_beat_hz(MIDDLE_C, third) < 1.0, "31-TET third ~beatless");
    assert!((fifth - ideal_fifth()) < -4.0, "5th should be ~5c flat, got {fifth}");
}

#[test]
fn tet12_third_audibly_beats() {
    let s = tet(12);
    let third = snap_interval(ideal_third(), &s, 1200.0);
    assert_eq!(third, 400.0);
    assert!((third - ideal_third() - 13.69).abs() < 0.1);
    let beat = major_third_beat_hz(MIDDLE_C, third);
    assert!((beat - 10.4).abs() < 0.5, "expected ~10.4 Hz beat, got {beat}");
}

#[test]
fn bohlen_pierce_with_octave_ratios_is_the_wrong_question() {
    let s = bohlen_pierce();
    let third = snap_interval(ideal_third(), &s, 1200.0 * 3f64.log2());
    assert!((third - ideal_third()) > 40.0, "far off: {third}");
    assert!(major_third_beat_hz(MIDDLE_C, third) > 20.0, "should beat hard");
}

// ===== Ordinal path: mode works, equal division makes a cluster =======

#[test]
fn ordinal_on_a_mode_yields_the_right_triad() {
    let s = ji_major_mode();
    assert!((s[2] - ideal_third()).abs() < 0.1, "ordinal 3rd {}", s[2]);
    assert!((s[4] - ideal_fifth()).abs() < 0.1, "ordinal 5th {}", s[4]);
}

#[test]
fn ordinal_on_an_equal_division_is_a_cluster_not_a_chord() {
    let s = tet(12);
    assert_eq!(s[2], 200.0);
    assert_eq!(s[4], 400.0);
    assert!((s[2] - ideal_third()).abs() > 150.0, "ordinal 3rd is a cluster tone");
}

// ===== The "no stable triad" guard is a threshold on a number =========

#[test]
fn beat_rate_guard_separates_triad_from_no_triad() {
    let pass_ji = major_third_beat_hz(MIDDLE_C, snap_interval(ideal_third(), &ji_major_mode(), 1200.0));
    let pass_31 = major_third_beat_hz(MIDDLE_C, snap_interval(ideal_third(), &tet(31), 1200.0));
    let fail_bp = major_third_beat_hz(
        MIDDLE_C,
        snap_interval(ideal_third(), &bohlen_pierce(), 1200.0 * 3f64.log2()),
    );
    assert!(pass_ji < NO_TRIAD_BEAT_HZ && pass_31 < NO_TRIAD_BEAT_HZ);
    assert!(fail_bp > NO_TRIAD_BEAT_HZ, "BP mis-snap must trip the guard");
}

// ===== End-to-end: parse .scl -> route -> generate triad ==============

const SCL_12TET: &str = "\
! 12-TET.scl
12 equal divisions of the octave
 12
 100.0
 200.0
 300.0
 400.0
 500.0
 600.0
 700.0
 800.0
 900.0
 1000.0
 1100.0
 2/1
";

const SCL_JI_MAJOR: &str = "\
! ji-major.scl
Ptolemaic just major mode
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
fn e2e_12tet_routes_to_ratio_snap_triad() {
    // 12-TET's third is ~14c off 5/4 (beats ~10 Hz) but is unquestionably a triad.
    // The cents guard keeps it; a register-dependent Hz guard would wrongly reject it.
    let scale = Scale::parse(SCL_12TET).expect("parse");
    let chord = generate_major_triad(&scale, 0, MIDDLE_C, NO_TRIAD_MAX_CENTS);
    assert!(matches!(chord.method, Method::RatioSnap));
    assert_eq!(chord.verdict, Verdict::Triad);
    assert_eq!(chord.tones.len(), 3);
    assert_eq!(chord.tones[1].cents_above_root, 400.0); // snapped third
    assert_eq!(chord.tones[2].cents_above_root, 700.0); // snapped fifth
}

#[test]
fn e2e_ji_major_routes_to_ordinal_pure_triad() {
    let scale = Scale::parse(SCL_JI_MAJOR).expect("parse");
    let chord = generate_major_triad(&scale, 0, MIDDLE_C, NO_TRIAD_MAX_CENTS);
    assert!(matches!(chord.method, Method::Ordinal));
    assert_eq!(chord.verdict, Verdict::Triad);
    assert!((chord.tones[1].cents_above_root - ideal_third()).abs() < 0.1);
    assert!(chord.tones[1].beat_hz < 0.1, "pure JI third must not beat");
}

// A genuine "no stable triad" tuning: 5-TET can't approximate 5/4 (nearest degree
// is ~94c off), so the guard must degrade to a dyad rather than emit a harsh chord.
const SCL_5TET: &str = "\
! 5-tet.scl
! kind: edo
5 equal divisions of the octave
 5
 240.0
 480.0
 720.0
 960.0
 2/1
";

#[test]
fn e2e_5tet_has_no_triad_and_degrades_to_dyad() {
    let scale = Scale::parse(SCL_5TET).expect("parse");
    let chord = generate_major_triad(&scale, 0, MIDDLE_C, NO_TRIAD_MAX_CENTS);
    assert_eq!(chord.verdict, Verdict::DegradedToDyad);
    assert_eq!(chord.tones.len(), 2); // root + best available partner
}
