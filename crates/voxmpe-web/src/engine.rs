//! The browser engine as plain Rust, tested natively. `lib.rs` exposes it to
//! JavaScript on wasm32.

use anyhow::{anyhow, bail, Context, Result};
use voxmpe::session::Session;
use voxmpe::settings::Settings;
use voxmpe_core::pitch::{self, CrepeModel, Prepared};
use voxmpe_core::types::Frame;
use voxmpe_core::{frames_from_raw, AnalysisConfig, Frames};

/// Longest take the browser analyzes: about 2 minutes of work at the measured speed.
pub const MAX_SECONDS: f32 = 600.0;

/// One pitch worker: CREPE tiny, loaded once.
pub struct Pitch {
    model: CrepeModel,
}

impl Pitch {
    pub fn new(model: &[u8]) -> Result<Pitch> {
        Ok(Pitch {
            model: CrepeModel::from_bytes(model)?,
        })
    }

    /// `f0_hz, confidence` for each listed frame, flattened.
    pub fn run(&self, audio16: &[f32], indices: &[u32]) -> Result<Vec<f32>> {
        Ok(self
            .model
            .pitch_frames(audio16, indices)?
            .into_iter()
            .flat_map(|(f0, conf)| [f0, conf])
            .collect())
    }
}

struct Pending {
    name: String,
    wav: Vec<u8>,
    audio: Vec<f32>,
    sample_rate: u32,
    prep: Prepared,
}

/// The studio worker: at most one take being analyzed and one take open.
#[derive(Default)]
pub struct Engine {
    pending: Option<Pending>,
    session: Option<Session>,
}

impl Engine {
    pub fn new() -> Engine {
        Engine::default()
    }

    /// Decode `wav` and list the frames the pitch workers must analyze.
    pub fn load(&mut self, name: &str, wav: Vec<u8>) -> Result<&Prepared> {
        let (audio, sample_rate) = voxmpe::audio::decode_wav(&wav)?;
        let seconds = audio.len() as f32 / sample_rate as f32;
        if seconds > MAX_SECONDS {
            bail!(
                "this take is {:.0} minutes long; the browser studio takes up to 10 minutes",
                seconds / 60.0
            );
        }
        let floor = AnalysisConfig::default().segmentation.rms_floor;
        let prep = pitch::prepare(&audio, sample_rate, floor);
        self.pending = Some(Pending {
            name: name.to_string(),
            wav,
            audio,
            sample_rate,
            prep,
        });
        Ok(&self.pending.as_ref().expect("just set").prep)
    }

    /// The take being analyzed, if any.
    pub fn prepared(&self) -> Option<&Prepared> {
        self.pending.as_ref().map(|p| &p.prep)
    }

    /// Open the loaded take from the workers' results (two floats per active
    /// frame, in `active` order). Returns the take info as JSON.
    pub fn finish(&mut self, results: &[f32]) -> Result<String> {
        let p = self.pending.take().context("no take is being analyzed")?;
        if !results.len().is_multiple_of(2) {
            bail!("pitch results must come in pairs");
        }
        let pairs: Vec<(f32, f32)> = results
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[f0, conf]| (f0, conf))
            .collect();
        let raw = pitch::assemble(p.prep.n_frames, &p.prep.active, &pairs)?;
        let frames = frames_from_raw(&raw, &p.audio, p.sample_rate, &AnalysisConfig::default());
        self.open(Session::from_frames(&p.name, p.wav, frames)?)
    }

    /// Reopen a take from its cached analysis. Returns the take info as JSON.
    /// A cache with the wrong frame count or hop was not made from this WAV
    /// and is refused, so the page analyzes the take again.
    pub fn restore(&mut self, name: &str, wav: Vec<u8>, frames: &[f32]) -> Result<String> {
        let frames = decode_frames(frames)?;
        let (audio, sample_rate) = voxmpe::audio::decode_wav(&wav)?;
        let expected = pitch::prepare(&audio, sample_rate, f32::INFINITY).n_frames;
        let hop = pitch::HOP as f32 / pitch::CREPE_SR as f32;
        if frames.frames.len() != expected || (frames.hop_s - hop).abs() > 1e-6 {
            bail!("analysis cache does not match this take");
        }
        self.open(Session::from_frames(name, wav, frames)?)
    }

    fn open(&mut self, s: Session) -> Result<String> {
        let info = serde_json::to_string(&s.info())?;
        self.session = Some(s);
        Ok(info)
    }

    /// The open take's analysis, to cache.
    pub fn frames(&self) -> Result<Vec<f32>> {
        Ok(encode_frames(self.session()?.frames()))
    }

    /// Notes for `settings_json`, as the server's `/api/render` returns them.
    pub fn render(&self, settings_json: &str) -> Result<String> {
        let session = self.session()?;
        let s = settings(settings_json)?;
        Ok(serde_json::to_string(&session.render(&s)?)?)
    }

    /// `.mid` (`format` "mid") or `.als` ("als") bytes.
    pub fn export(&self, settings_json: &str, format: &str) -> Result<Vec<u8>> {
        let session = self.session()?;
        let s = settings(settings_json)?;
        match format {
            "mid" => session.export_mid(&s),
            "als" => session.export_als(&s),
            other => bail!("unknown export format {other:?}"),
        }
    }

    fn session(&self) -> Result<&Session> {
        self.session.as_ref().context("no take is open")
    }
}

/// Settings from JSON, the tuning checked first so its error reads
/// "tuning: ..." like the server's (the page falls back on that prefix).
fn settings(json: &str) -> Result<Settings> {
    let s: Settings = serde_json::from_str(json).context("reading settings")?;
    s.tuning().map_err(|e| anyhow!("tuning: {e}"))?;
    Ok(s)
}

/// The built-in tunings as JSON, as the server's `/api/tunings`.
pub fn tunings_json() -> String {
    serde_json::to_string(&voxmpe::tunings::presets()).expect("tunings serialize")
}

/// Floats per frame in the cache encoding.
const FIELDS: usize = 6;

/// Frames as floats for the cache: the hop, then six values per frame.
pub fn encode_frames(f: &Frames) -> Vec<f32> {
    let mut v = Vec::with_capacity(1 + f.frames.len() * FIELDS);
    v.push(f.hop_s);
    for fr in &f.frames {
        let voiced = if fr.voiced { 1.0 } else { 0.0 };
        v.extend([
            fr.time,
            fr.f0_hz,
            fr.confidence,
            fr.rms,
            fr.centroid_hz,
            voiced,
        ]);
    }
    v
}

pub fn decode_frames(v: &[f32]) -> Result<Frames> {
    let (&hop_s, rest) = v.split_first().context("empty analysis cache")?;
    let (rows, extra) = rest.as_chunks::<FIELDS>();
    if !extra.is_empty() {
        bail!("damaged analysis cache");
    }
    Ok(Frames {
        hop_s,
        frames: rows
            .iter()
            .map(
                |&[time, f0_hz, confidence, rms, centroid_hz, voiced]| Frame {
                    time,
                    f0_hz,
                    confidence,
                    rms,
                    centroid_hz,
                    voiced: voiced != 0.0,
                },
            )
            .collect(),
    })
}
