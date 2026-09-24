//! Everything the user can adjust, shared by the studio UI and the CLI.

use serde::{Deserialize, Serialize};
use voxmpe_core::smf::OutputMode;
use voxmpe_core::{AnalysisConfig, SegmentationConfig};

use crate::quantize::Tuning;
use crate::scala::Scale;

/// 1/1 anchor default: middle C, which aligns a 12-TET scale to concert A440.
pub const MIDDLE_C_HZ: f64 = 261.625565;

/// Built-in 12-TET scale, used when no `.scl` is chosen.
pub const TET12_SCL: &str = "! 12-tet.scl
12 equal divisions of the octave
 12
 100.
 200.
 300.
 400.
 500.
 600.
 700.
 800.
 900.
 1000.
 1100.
 2/1
";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// How long a small pitch move must hold to start a note (ms).
    pub hold_ms: f32,
    /// How long a big jump (`jump_cents` or more) must hold (ms).
    pub jump_hold_ms: f32,
    pub jump_cents: f32,
    /// Silence (ms) that forces a new note.
    pub gap_ms: f32,
    /// Pitch move (cents) that can start a note.
    pub split_cents: f32,
    /// Loudness re-attack threshold (0.6 = +60%); `None` never splits on loudness.
    pub onset_delta: Option<f32>,
    /// Display name of the tuning (file name or path). `None` = 12-TET.
    pub tuning_name: Option<String>,
    /// Scala `.scl` text. `None` = 12-TET.
    pub tuning_scl: Option<String>,
    /// Frequency (Hz) of the scale's 1/1.
    pub anchor_hz: f64,
    /// `Some(range)`: single-channel MIDI with that bend range. `None`: MPE.
    pub single_channel: Option<u8>,
}

impl Default for Settings {
    fn default() -> Self {
        let s = SegmentationConfig::default();
        Self {
            hold_ms: s.hold_time_ms,
            jump_hold_ms: s.jump_hold_ms,
            jump_cents: s.jump_cents,
            gap_ms: s.voicing_gap_ms,
            split_cents: s.split_cents,
            onset_delta: Some(s.onset_rms_delta),
            tuning_name: None,
            tuning_scl: None,
            anchor_hz: MIDDLE_C_HZ,
            single_channel: None,
        }
    }
}

impl Settings {
    /// Preset for sung lyrics: bridge consonant gaps, hold longer, ignore loudness.
    pub fn legato() -> Self {
        Self {
            hold_ms: 180.0,
            gap_ms: 150.0,
            onset_delta: None,
            ..Self::default()
        }
    }

    pub fn analysis_config(&self) -> AnalysisConfig {
        let mut cfg = AnalysisConfig::default();
        let s = &mut cfg.segmentation;
        s.hold_time_ms = self.hold_ms;
        s.jump_hold_ms = self.jump_hold_ms;
        s.jump_cents = self.jump_cents;
        s.voicing_gap_ms = self.gap_ms;
        s.split_cents = self.split_cents;
        s.onset_rms_delta = self.onset_delta.unwrap_or(f32::INFINITY);
        cfg
    }

    pub fn tuning(&self) -> Result<Tuning, String> {
        let scale = Scale::parse(self.tuning_scl.as_deref().unwrap_or(TET12_SCL))?;
        Ok(Tuning::new(&scale, self.anchor_hz))
    }

    pub fn output_mode(&self) -> OutputMode {
        match self.single_channel {
            Some(bend_range) => OutputMode::SingleChannel { bend_range },
            None => OutputMode::Mpe,
        }
    }

    /// `voxmpe convert` flags that reproduce these settings (non-defaults only).
    pub fn to_flags(&self) -> String {
        let d = Settings::default();
        let mut f: Vec<String> = Vec::new();
        let mut num = |name: &str, v: f32, dv: f32| {
            if v != dv {
                f.push(format!("--{name} {v}"));
            }
        };
        num("hold-ms", self.hold_ms, d.hold_ms);
        num("jump-hold-ms", self.jump_hold_ms, d.jump_hold_ms);
        num("jump-cents", self.jump_cents, d.jump_cents);
        num("gap-ms", self.gap_ms, d.gap_ms);
        num("split-cents", self.split_cents, d.split_cents);
        match self.onset_delta {
            None => f.push("--no-onset".into()),
            Some(v) if Some(v) != d.onset_delta => f.push(format!("--onset-delta {v}")),
            Some(_) => {}
        }
        if let Some(n) = &self.tuning_name {
            if n.contains(char::is_whitespace) {
                f.push(format!("--tuning '{n}'"));
            } else {
                f.push(format!("--tuning {n}"));
            }
        }
        if self.anchor_hz != d.anchor_hz {
            f.push(format!("--anchor-hz {}", self.anchor_hz));
        }
        if let Some(r) = self.single_channel {
            f.push(format!("--single-channel {r}"));
        }
        f.join(" ")
    }
}
