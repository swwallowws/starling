//! Shared data types for the analysis pipeline.

/// One analysis frame, aligned across pitch + features (10 ms hop).
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    /// Frame center time in seconds.
    pub time: f32,
    /// Fundamental frequency in Hz (meaningless if `!voiced`).
    pub f0_hz: f32,
    /// CREPE peak confidence in [0, 1].
    pub confidence: f32,
    /// RMS amplitude (linear, 0..~1).
    pub rms: f32,
    /// Spectral centroid in Hz (timbre; optional downstream).
    pub centroid_hz: f32,
    /// Voicing decision after the gate.
    pub voiced: bool,
}

/// A single point on a per-note expression curve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurvePoint {
    /// Time in seconds, absolute (song time).
    pub time: f32,
    /// Value: semitones (bend) or 0..1 (normalized CC source).
    pub value: f32,
}

/// A segmented note with continuous per-note expression.
///
/// Expression is stored in a normalized, MIDI-agnostic form. MPE channel
/// assignment, pitchbend-range scaling, and CC byte mapping happen at
/// serialization time, driven from this structure.
#[derive(Debug, Clone)]
pub struct Note {
    /// Quantized MIDI pitch (0..127), the note's center, ROUNDED to 12-TET.
    /// Convenience for the 12-TET path (`smf`); microtonal consumers ignore it
    /// and quantize [`pitch_center`](Self::pitch_center) to their own scale instead.
    pub pitch: u8,
    /// THE SEAM (see crate docs & SPEC §5.4). The note's pitch center as a
    /// *fractional* MIDI note number in semitones: NOT rounded to any scale.
    /// This is the value the engine must never discard: a downstream consumer
    /// quantizes it to a non-12-TET scale (the `voxmpe` app), while the
    /// 12-TET path just reads [`pitch`](Self::pitch) = `round_to_12tet(pitch_center)`.
    pub pitch_center: f64,
    /// Note start time (seconds).
    pub start: f32,
    /// Note end time (seconds).
    pub end: f32,
    /// Attack velocity in [0, 1] (scaled to 1..127 at write time).
    pub velocity: f32,
    /// Per-note pitch deviation from `pitch`, in semitones, over time.
    /// Carries vibrato / scoops / glides. Absolute times.
    pub bend: Vec<CurvePoint>,
    /// Per-note amplitude in [0, 1] over time -> CC11 (expression).
    pub amplitude: Vec<CurvePoint>,
    /// Reserved MPE dimension: channel pressure in [0, 1] (unused for now, but
    /// kept so the per-note expression model generalizes: SPEC §6).
    pub pressure: Vec<CurvePoint>,
    /// Reserved MPE dimension: timbre/slide -> CC74 in [0, 1] (unused for now).
    pub slide: Vec<CurvePoint>,
}

impl Note {
    pub fn duration(&self) -> f32 {
        self.end - self.start
    }
}

/// Full analysis result returned by [`crate::analyze`].
#[derive(Debug, Clone)]
pub struct Analysis {
    /// All analysis frames (voiced + unvoiced), for inspection/debugging.
    pub frames: Vec<Frame>,
    /// Segmented notes with expression.
    pub notes: Vec<Note>,
    /// Hop size in seconds (frame spacing).
    pub hop_s: f32,
}
