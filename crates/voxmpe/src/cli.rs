//! Command-line flags that map onto [`Settings`]; the studio shows the same flags.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};

use crate::settings::Settings;

#[derive(clap::Args, Debug, Default)]
pub struct SettingsArgs {
    /// How long a small pitch move must hold to start a note (ms, default 90)
    #[arg(long)]
    pub hold_ms: Option<f32>,
    /// How long a big jump must hold (ms, default 90)
    #[arg(long)]
    pub jump_hold_ms: Option<f32>,
    /// Interval counted as a big jump (cents, default 300)
    #[arg(long)]
    pub jump_cents: Option<f32>,
    /// Silence that forces a new note (ms, default 80)
    #[arg(long)]
    pub gap_ms: Option<f32>,
    /// Pitch move that can start a note (cents, default 70)
    #[arg(long)]
    pub split_cents: Option<f32>,
    /// Loudness re-attack that starts a note (0.6 = +60%, default 0.6)
    #[arg(long, conflicts_with = "no_onset")]
    pub onset_delta: Option<f32>,
    /// Never split a note on loudness alone
    #[arg(long)]
    pub no_onset: bool,
    /// Start from the preset for sung lyrics (explicit flags still override)
    #[arg(long)]
    pub legato: bool,
    /// Scala .scl tuning file (omit for 12-TET)
    #[arg(long)]
    pub tuning: Option<PathBuf>,
    /// Frequency (Hz) of the scale's 1/1 (default middle C, 261.63)
    #[arg(long)]
    pub anchor_hz: Option<f64>,
    /// Single-channel MIDI with this bend range (semitones) instead of MPE
    #[arg(long)]
    pub single_channel: Option<u8>,
}

impl SettingsArgs {
    pub fn to_settings(&self) -> Result<Settings> {
        let mut s = if self.legato {
            Settings::legato()
        } else {
            Settings::default()
        };
        if let Some(v) = self.hold_ms {
            s.hold_ms = v;
        }
        if let Some(v) = self.jump_hold_ms {
            s.jump_hold_ms = v;
        }
        if let Some(v) = self.jump_cents {
            s.jump_cents = v;
        }
        if let Some(v) = self.gap_ms {
            s.gap_ms = v;
        }
        if let Some(v) = self.split_cents {
            s.split_cents = v;
        }
        if self.no_onset {
            s.onset_delta = None;
        } else if let Some(v) = self.onset_delta {
            s.onset_delta = Some(v);
        }
        if let Some(p) = &self.tuning {
            let text = std::fs::read_to_string(p)
                .with_context(|| format!("reading tuning {}", p.display()))?;
            s.tuning_scl = Some(text);
            s.tuning_name = Some(p.display().to_string());
        }
        if let Some(v) = self.anchor_hz {
            s.anchor_hz = v;
        }
        s.single_channel = self.single_channel;
        s.tuning().map_err(|e| anyhow!("parsing tuning: {e}"))?;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use voxmpe_core::AnalysisConfig;

    #[derive(Parser)]
    struct T {
        #[command(flatten)]
        a: SettingsArgs,
    }

    fn parse(flags: &str) -> Settings {
        let args = std::iter::once("t").chain(flags.split_whitespace());
        T::try_parse_from(args).unwrap().a.to_settings().unwrap()
    }

    #[test]
    fn defaults_match_the_core() {
        assert_eq!(
            format!("{:?}", Settings::default().analysis_config()),
            format!("{:?}", AnalysisConfig::default())
        );
        assert_eq!(Settings::default().to_flags(), "");
    }

    #[test]
    fn legato_preset() {
        let l = Settings::legato();
        assert_eq!((l.hold_ms, l.gap_ms, l.onset_delta), (180.0, 150.0, None));
        assert_eq!(
            l.analysis_config().segmentation.onset_rms_delta,
            f32::INFINITY
        );
        assert_eq!(parse("--legato"), l);
    }

    #[test]
    fn flags_round_trip() {
        let scl = std::env::temp_dir().join(format!("voxmpe_rt_{}.scl", std::process::id()));
        std::fs::write(&scl, "! t\n5-EDO\n 5\n 240.\n 480.\n 720.\n 960.\n 2/1\n").unwrap();
        let cases = [
            Settings::legato(),
            Settings {
                hold_ms: 150.0,
                jump_hold_ms: 50.0,
                split_cents: 90.0,
                ..Settings::default()
            },
            Settings {
                onset_delta: Some(1.2),
                anchor_hz: 440.0,
                single_channel: Some(2),
                ..Settings::default()
            },
            Settings {
                tuning_name: Some(scl.display().to_string()),
                tuning_scl: Some(std::fs::read_to_string(&scl).unwrap()),
                ..Settings::default()
            },
        ];
        for s in cases {
            assert_eq!(parse(&s.to_flags()), s, "flags: {}", s.to_flags());
        }
        std::fs::remove_file(scl).ok();
    }

    #[test]
    fn invalid_scl_is_an_error() {
        let s = Settings {
            tuning_scl: Some("not a scale".into()),
            ..Settings::default()
        };
        assert!(s.tuning().is_err());
    }
}
