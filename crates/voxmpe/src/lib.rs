//! voxmpe app library: tuning, settings, sessions and the studio server, on top of `voxmpe-core`.
//!
//! Shared pitch/MPE primitives (freq→note/bend, cents↔ratio↔freq) live in
//! [`voxmpe_core`]; this crate adds what is microtonal-specific:
//! - [`scala`]: Scala `.scl` tuning import (cents and ratio entries, one path).
//! - [`chord`]: microtonal chord generation (mode -> ordinal, edo -> ratio-snap,
//!   with a cents-deviation "no stable triad" guard).
//!
//! See MICROTONAL_SPEC.md for the design rationale and reference numbers.

pub mod audio;
pub mod chord;
pub mod cli;
pub mod model;
pub mod quantize;
pub mod retune;
pub mod scala;
pub mod server;
pub mod session;
pub mod settings;
