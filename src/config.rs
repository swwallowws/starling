//! Tunable analysis parameters. Every segmentation threshold lives here — no
//! magic numbers buried in the algorithm (see SPEC §5).

/// Note-segmentation thresholds. The defining knob is [`hold_time_ms`].
#[derive(Debug, Clone)]
pub struct SegmentationConfig {
    /// Shortest run (ms) that counts as a note; shorter voiced blips are dropped/merged.
    pub min_voiced_run_ms: f32,
    /// Unvoiced run (ms) long enough to be a hard note boundary.
    pub voicing_gap_ms: f32,
    /// **Main knob.** How long a new pitch center must hold (ms) to count as a
    /// new note rather than vibrato/transient. Vibrato never settles; a real
    /// note does. (SPEC §5)
    pub hold_time_ms: f32,
    /// A forward window whose median differs from the current center by at least
    /// this many cents (and is itself stable) starts a new note.
    pub split_cents: f32,
    /// Max pitch deviation (cents, std) for a window to count as "stable /
    /// settled". A held note sits well under this; vibrato/glide windows exceed
    /// it, which is what stops a wobble from being read as a new note.
    pub stability_cents: f32,
    /// Relative RMS rise (e.g. 0.6 = +60%) above a recent local minimum that
    /// re-articulates the same pitch as a new note (SPEC §5 amplitude onset).
    pub onset_rms_delta: f32,
    /// Median-filter width (frames) for jitter suppression on the contour used
    /// for *segmentation* (the raw contour is kept for the bend curve).
    pub median_filter_frames: usize,
    /// CREPE confidence below this marks a frame unvoiced.
    pub confidence_threshold: f32,
    /// RMS below this (linear) marks a frame unvoiced (silence floor).
    pub rms_floor: f32,
}

impl Default for SegmentationConfig {
    fn default() -> Self {
        Self {
            min_voiced_run_ms: 60.0,
            voicing_gap_ms: 80.0,
            hold_time_ms: 90.0,
            split_cents: 70.0,
            stability_cents: 35.0,
            onset_rms_delta: 0.6,
            median_filter_frames: 5,
            confidence_threshold: 0.5,
            rms_floor: 0.005,
        }
    }
}

/// Expression-encoding parameters (curve density, dynamics mapping).
#[derive(Debug, Clone)]
pub struct ExpressionConfig {
    /// Drop a bend point if it differs from the last emitted one by less than
    /// this many semitones (perceptual thinning to avoid flooding the file).
    pub bend_thin_semitones: f32,
    /// Likewise for the amplitude (CC11) curve, in normalized [0,1] units.
    pub amp_thin: f32,
    /// Velocity = this exponent applied to normalized attack amplitude (gamma).
    pub velocity_gamma: f32,
    /// Floor for note-on velocity in [0,1] so quiet onsets still sound.
    pub velocity_floor: f32,
}

impl Default for ExpressionConfig {
    fn default() -> Self {
        Self {
            bend_thin_semitones: 0.02,
            amp_thin: 0.02,
            velocity_gamma: 0.6,
            velocity_floor: 0.15,
        }
    }
}

/// Top-level analysis configuration.
#[derive(Debug, Clone, Default)]
pub struct AnalysisConfig {
    pub segmentation: SegmentationConfig,
    pub expression: ExpressionConfig,
}
