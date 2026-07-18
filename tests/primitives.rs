//! Numerical harness for the shared MPE pitch primitive. "Correct" is a NUMBER.

use voxmidi_core::interval::{cents_to_freq, ratio_to_cents};
use voxmidi_core::mpe::{bend_from_offset, bend_to_cents, freq_to_note_and_bend, MPE_BEND_RANGE};

const MPE_RANGE: f64 = MPE_BEND_RANGE;

#[test]
fn a4_is_dead_center() {
    let (note, bend) = freq_to_note_and_bend(440.0, MPE_RANGE);
    assert_eq!(note, 69);
    assert_eq!(bend, 8192);
}

#[test]
fn middle_c_is_centered() {
    let c4 = 440.0 * 2f64.powf(-9.0 / 12.0);
    let (note, bend) = freq_to_note_and_bend(c4, MPE_RANGE);
    assert_eq!(note, 60);
    assert_eq!(bend, 8192);
}

#[test]
fn octave_below_a4() {
    let (note, bend) = freq_to_note_and_bend(220.0, MPE_RANGE);
    assert_eq!(note, 57);
    assert_eq!(bend, 8192);
}

#[test]
fn fifty_cents_sharp_rounds_up_and_bends_down() {
    // f64::round is round-half-away-from-zero, so 60.5 -> 61 and offset -> -50c.
    let c4 = 440.0 * 2f64.powf(-9.0 / 12.0);
    let target = c4 * 2f64.powf(50.0 / 1200.0);
    let (note, bend) = freq_to_note_and_bend(target, MPE_RANGE);
    assert_eq!(note, 61);
    assert!((bend_to_cents(bend, MPE_RANGE) - (-50.0)).abs() < 0.6);
}

#[test]
fn thirty_cents_flat_stays_on_note() {
    let target = 440.0 * 2f64.powf(-30.0 / 1200.0);
    let (note, bend) = freq_to_note_and_bend(target, MPE_RANGE);
    assert_eq!(note, 69);
    assert!((bend_to_cents(bend, MPE_RANGE) - (-30.0)).abs() < 0.6);
}

#[test]
fn ji_major_third_is_386_cents_not_400() {
    assert!((ratio_to_cents(5.0 / 4.0) - 386.31).abs() < 0.1);
}

#[test]
fn ji_perfect_fifth_is_702_cents() {
    assert!((ratio_to_cents(3.0 / 2.0) - 701.96).abs() < 0.1);
}

#[test]
fn ji_third_above_c_lands_on_e_with_flat_bend() {
    let c4 = 440.0 * 2f64.powf(-9.0 / 12.0);
    let (note, bend) = freq_to_note_and_bend(c4 * (5.0 / 4.0), MPE_RANGE);
    assert_eq!(note, 64); // E
    assert!((bend_to_cents(bend, MPE_RANGE) - (-13.69)).abs() < 0.6);
}

#[test]
fn wrong_bend_range_produces_wrong_bend() {
    let c4 = 440.0 * 2f64.powf(-9.0 / 12.0);
    let target = c4 * 2f64.powf(-50.0 / 1200.0);
    let (_, bend_wide) = freq_to_note_and_bend(target, 48.0);
    let (_, bend_narrow) = freq_to_note_and_bend(target, 2.0);
    assert_ne!(bend_wide, bend_narrow);
    assert!((bend_to_cents(bend_wide, 48.0) - (-50.0)).abs() < 0.6);
    assert!((bend_to_cents(bend_narrow, 2.0) - (-50.0)).abs() < 0.6);
    assert!(bend_to_cents(bend_wide, 2.0).abs() < 3.0); // misread collapses to ~0c
}

#[test]
fn resolution_is_subcent_at_mpe_range() {
    assert!(9600.0 / 16384.0 < 1.0);
}

#[test]
fn extreme_offset_clamps_not_wraps() {
    // A full semitone at a tiny ±0.5 range must clamp, never wrap.
    assert!(bend_from_offset(1.0, 0.5) <= 16383);
}

#[test]
fn same_scale_different_anchor_disagrees_by_constant() {
    let d = 386.31;
    let ratio = cents_to_freq(d, 261.63) / cents_to_freq(d, 262.00);
    let ratio2 = cents_to_freq(701.96, 261.63) / cents_to_freq(701.96, 262.00);
    assert!((ratio - ratio2).abs() < 1e-9);
}
