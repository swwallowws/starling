//! One loaded take: decoded once, CREPE-tracked once, re-rendered per settings.

use anyhow::{anyhow, Result};
use serde::Serialize;
use voxmpe_core::segment::{self, Cause};
use voxmpe_core::smf::smf_bytes;
use voxmpe_core::types::Analysis;
use voxmpe_core::{track, transcribe, AnalysisConfig, CrepeModel, Frames};

use crate::audio::{decode_wav, peak};
use crate::expression::shape;
use crate::retune::retune;
use crate::settings::Settings;

/// Below this peak level a take is probably the wrong mic or muted.
const QUIET_PEAK: f32 = 0.01;
/// CREPE confidence at which the raw contour is drawn.
const CONTOUR_CONFIDENCE: f32 = 0.5;

pub struct Session {
    pub name: String,
    pub wav: Vec<u8>,
    duration_s: f32,
    frames: Frames,
    warning: Option<String>,
}

#[derive(Serialize)]
pub struct TakeInfo {
    pub name: String,
    pub duration_s: f32,
    pub hop_s: f32,
    /// Raw sung pitch per frame (fractional MIDI note), `None` where unvoiced.
    pub contour: Vec<Option<f32>>,
    /// Per-frame loudness, normalized to 0..1.
    pub loudness: Vec<f32>,
    pub warning: Option<String>,
}

#[derive(Serialize)]
pub struct RNote {
    pub pitch: u8,
    pub center: f64,
    pub start: f32,
    pub end: f32,
    pub velocity: f32,
    pub cause: &'static str,
    /// `[time_s, semitones relative to pitch]`
    pub bend: Vec<[f32; 2]>,
    /// `[time_s, 0..1]`
    pub amp: Vec<[f32; 2]>,
}

#[derive(Serialize)]
pub struct Rendered {
    pub notes: Vec<RNote>,
    pub flags: String,
}

impl Session {
    pub fn load(name: &str, wav: Vec<u8>, model: &CrepeModel) -> Result<Session> {
        let (audio, sr) = decode_wav(&wav)?;
        let frames = track(&audio, sr, model, &AnalysisConfig::default())?;
        Ok(Session::assemble(name, wav, &audio, sr, frames))
    }

    /// A take whose slow analysis ran elsewhere (the browser's pitch workers,
    /// or a cache). `frames` must come from this same WAV.
    pub fn from_frames(name: &str, wav: Vec<u8>, frames: Frames) -> Result<Session> {
        let (audio, sr) = decode_wav(&wav)?;
        Ok(Session::assemble(name, wav, &audio, sr, frames))
    }

    /// The slow stage's output, to cache.
    pub fn frames(&self) -> &Frames {
        &self.frames
    }

    fn assemble(name: &str, wav: Vec<u8>, audio: &[f32], sr: u32, frames: Frames) -> Session {
        let warning = (peak(audio) < QUIET_PEAK).then(|| {
            "Very quiet take: check that the right mic is selected and its level is up.".to_string()
        });
        Session {
            name: name.to_string(),
            wav,
            duration_s: audio.len() as f32 / sr as f32,
            frames,
            warning,
        }
    }

    pub fn info(&self) -> TakeInfo {
        let max = self
            .frames
            .frames
            .iter()
            .map(|f| f.rms)
            .fold(0.0f32, f32::max);
        TakeInfo {
            name: self.name.clone(),
            duration_s: self.duration_s,
            hop_s: self.frames.hop_s,
            contour: self
                .frames
                .frames
                .iter()
                .map(|f| {
                    (f.confidence >= CONTOUR_CONFIDENCE && f.f0_hz > 0.0)
                        .then(|| segment::hz_to_semitones(f.f0_hz))
                })
                .collect(),
            loudness: self
                .frames
                .frames
                .iter()
                .map(|f| {
                    if max > 0.0 {
                        (f.rms / max).clamp(0.0, 1.0)
                    } else {
                        0.0
                    }
                })
                .collect(),
            warning: self.warning.clone(),
        }
    }

    pub fn render(&self, s: &Settings) -> Result<Rendered> {
        let analysis = self.analysis(s)?;
        let spans = segment::segment(
            &analysis.frames,
            analysis.hop_s,
            &s.analysis_config().segmentation,
        );
        let notes = analysis
            .notes
            .iter()
            .zip(&spans)
            .map(|(n, span)| RNote {
                pitch: n.pitch,
                center: n.pitch_center,
                start: n.start,
                end: n.end,
                velocity: n.velocity,
                cause: match span.cause {
                    Cause::Voicing => "gap",
                    Cause::PitchChange => "pitch",
                    Cause::Reattack => "reattack",
                },
                bend: n.bend.iter().map(|p| [p.time, p.value]).collect(),
                amp: n.amplitude.iter().map(|p| [p.time, p.value]).collect(),
            })
            .collect();
        Ok(Rendered {
            notes,
            flags: s.to_flags(),
        })
    }

    pub fn export_mid(&self, s: &Settings) -> Result<Vec<u8>> {
        smf_bytes(&self.analysis(s)?, s.output_mode())
    }

    /// An Ableton Live set whose clip carries each note's bend as Live's own
    /// per-note pitch expression, with the tuning loaded when it isn't 12-TET.
    pub fn export_als(&self, s: &Settings) -> Result<Vec<u8>> {
        let name = self.name.trim_end_matches(".wav");
        crate::als::als_bytes(&self.analysis(s)?, name, self.duration_s, s)
    }

    fn analysis(&self, s: &Settings) -> Result<Analysis> {
        let tuning = s.tuning().map_err(|e| anyhow!("tuning: {e}"))?;
        let mut a = retune(&transcribe(&self.frames, &s.analysis_config()), &tuning);
        shape(&mut a, &tuning, &s.shape());
        Ok(a)
    }
}
