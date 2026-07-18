//! Cents ↔ ratio ↔ frequency conversions — the shared music-math layer.
//!
//! A `.scl` gives INTERVALS only; an anchor (reference Hz) makes them concrete.
//! Keep the anchor FIXED across every comparison — an anchor mismatch shows up as a
//! constant ratio across all degrees (not a per-note error).

/// Ratio -> cents, so ratio-based `.scl` entries share one code path with cents.
pub fn ratio_to_cents(ratio: f64) -> f64 {
    1200.0 * ratio.log2()
}

/// Cents above an anchor -> absolute frequency.
pub fn cents_to_freq(cents: f64, anchor_hz: f64) -> f64 {
    anchor_hz * 2f64.powf(cents / 1200.0)
}
