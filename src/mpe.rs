//! The core primitive: frequency -> (MIDI note, 14-bit pitch bend), and the bend
//! encoder underneath it.
//!
//! Reconciles the two siblings' overlapping code into ONE API:
//! - [`bend_from_offset`] is the low-level encoder (singmidi's `bend_value`): a
//!   semitone offset within ±range -> 14-bit bend. Use when the note is already chosen.
//! - [`freq_to_note_and_bend`] is the full split (microtonal-aud2midi's primitive):
//!   frequency -> nearest MIDI note + the bend carrying the remainder.
//!
//! Everything hinges on the fractional MIDI note number: compute it first, never lose
//! the fraction until the final split.

/// MPE member-channel pitch-bend range, in semitones.
///
/// THIS IS A CONTRACT: it must equal the receiving synth's configured range, or every
/// microtonal offset comes out wrong by a constant factor (the #1 microtonal MPE bug).
/// Send RPN 0,0 at note-on so you don't trust the synth's saved state.
pub const MPE_BEND_RANGE: f64 = 48.0;

/// Encode a semitone offset (within ±`bend_range`) as a 14-bit bend value.
/// 8192 = center (no bend). Clamps to a valid 14-bit value rather than wrapping.
pub fn bend_from_offset(semitone_offset: f64, bend_range: f64) -> u16 {
    let bend_f = 8192.0 + semitone_offset * (8192.0 / bend_range);
    bend_f.round().clamp(0.0, 16383.0) as u16
}

/// Convert a target frequency to a MIDI note number and a 14-bit pitch bend.
/// Round-to-nearest note keeps the worst-case bend within ±50 cents.
pub fn freq_to_note_and_bend(freq: f64, bend_range: f64) -> (u8, u16) {
    let n_float = 69.0 + 12.0 * (freq / 440.0).log2();
    let note = n_float.round();
    let offset = n_float - note; // semitones, in (-0.5, +0.5]
    (note as u8, bend_from_offset(offset, bend_range))
}

/// Split a 14-bit bend into (lsb, msb) for a `0xE0|channel, lsb, msb` message.
pub fn bend_bytes(bend: u16) -> (u8, u8) {
    ((bend & 0x7F) as u8, ((bend >> 7) & 0x7F) as u8)
}

/// Round-trip a bend value back into cents, given the range it was encoded with.
/// Lets tests and diagnostics assert "this note is ~X cents off" in human terms.
pub fn bend_to_cents(bend: u16, bend_range: f64) -> f64 {
    ((bend as f64) - 8192.0) / (8192.0 / bend_range) * 100.0
}
