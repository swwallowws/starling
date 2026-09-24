//! Microtonal voice-to-MIDI — the distinctive wedge on top of `voxmidi-core`.
//!
//! Shared pitch/MPE primitives (freq→note/bend, cents↔ratio↔freq) live in
//! [`voxmpe_core`]; this crate adds what is microtonal-specific:
//! - [`scala`] — Scala `.scl` tuning import (cents and ratio entries, one path).
//! - [`chord`] — microtonal chord generation (mode -> ordinal, edo -> ratio-snap,
//!   with a cents-deviation "no stable triad" guard).
//!
//! See MICROTONAL_SPEC.md for the design rationale and reference numbers.

pub mod scala;
pub mod chord;
pub mod quantize;
pub mod retune;
