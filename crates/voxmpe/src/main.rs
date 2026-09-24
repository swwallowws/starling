//! microtonal-voxmidi CLI — WAV in, microtonal MPE `.mid` out.
//!
//! Pipeline: `voxmpe_core::analyze` (CREPE pitch + segmentation + expression) ->
//! [`voxmpe::retune`] (snap each note to a `.scl` degree, preserve vibrato) ->
//! `voxmpe_core::smf::write_smf`. Omit `--tuning` for plain 12-TET (the successor to
//! the retired `singmidi`). Mic capture is intentionally left out (no ALSA dep).

use anyhow::{anyhow, Context, Result};
use clap::Parser;

use voxmpe::quantize::Tuning;
use voxmpe::retune::retune;
use voxmpe::scala::Scale;
use voxmpe_core::smf::{write_smf, OutputMode};
use voxmpe_core::{analyze, AnalysisConfig, CrepeModel};

/// CREPE model path (85 MB, gitignored; see models/README.md).
const DEFAULT_MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-full.onnx");
/// 1/1 anchor default: middle C, which aligns a 12-TET scale to concert A440.
const MIDDLE_C_HZ: f64 = 261.625565;

/// Built-in default tuning: plain 12-TET (used when `--tuning` is omitted).
const TET12_SCL: &str = "! 12-tet.scl
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

#[derive(Parser)]
#[command(name = "microtonal-voxmidi", about = "Microtonal singing voice -> MPE MIDI (offline)")]
struct Cli {
    /// Input WAV file (mono or stereo; any sample rate).
    input: String,
    /// Output MIDI path.
    #[arg(short, long, default_value = "out.mid")]
    output: String,
    /// Scala `.scl` tuning file. Omit for 12-TET.
    #[arg(short, long)]
    tuning: Option<String>,
    /// Anchor: frequency (Hz) of the scale's 1/1 degree. Keep FIXED across comparisons.
    #[arg(long, default_value_t = MIDDLE_C_HZ)]
    anchor_hz: f64,
    /// CREPE ONNX model path.
    #[arg(long, default_value = DEFAULT_MODEL)]
    model: String,
    /// Use single-channel pitch bend (given range, semitones) instead of MPE.
    #[arg(long)]
    single_channel: Option<u8>,
    /// Segmentation hold-time knob (ms) — higher = fewer, longer notes.
    #[arg(long)]
    hold_time_ms: Option<f32>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // 1. Audio -> engine analysis (fractional pitch centers preserved).
    let (audio, sr) = read_wav(&cli.input)?;
    let model = CrepeModel::from_path(&cli.model)
        .with_context(|| format!("loading CREPE model from {}", cli.model))?;
    let mut cfg = AnalysisConfig::default();
    if let Some(h) = cli.hold_time_ms {
        cfg.segmentation.hold_time_ms = h;
    }
    let analysis = analyze(&audio, sr, &model, &cfg)?;

    // 2. Load tuning and retune (the microtonal seam + vibrato-preserving bend merge).
    let (scl_text, tuning_name) = match &cli.tuning {
        Some(p) => (
            std::fs::read_to_string(p).with_context(|| format!("reading tuning {p}"))?,
            p.as_str(),
        ),
        None => (TET12_SCL.to_string(), "12-TET"),
    };
    let scale = Scale::parse(&scl_text).map_err(|e| anyhow!("parsing tuning: {e}"))?;
    let tuning = Tuning::new(&scale, cli.anchor_hz);
    let retuned = retune(&analysis, &tuning);

    // 3. Serialize to a Standard MIDI File.
    let mode = match cli.single_channel {
        Some(range) => OutputMode::SingleChannel { bend_range: range },
        None => OutputMode::Mpe,
    };
    write_smf(&retuned, mode, &cli.output)?;

    eprintln!(
        "{} notes  tuning={}  anchor={:.2}Hz  -> {}",
        retuned.notes.len(),
        tuning_name,
        cli.anchor_hz,
        cli.output
    );
    for n in &retuned.notes {
        let bend0 = n.bend.first().map(|p| p.value * 100.0).unwrap_or(0.0);
        eprintln!(
            "  note {:>3}  {:5.2}-{:5.2}s  start bend {:+5.1}c  ({} pts)",
            n.pitch,
            n.start,
            n.end,
            bend0,
            n.bend.len()
        );
    }
    Ok(())
}

/// Read a WAV into mono f32 + sample rate (multichannel is downmixed).
fn read_wav(path: &str) -> Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path).with_context(|| format!("opening {path}"))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<_, _>>()?
        }
    };
    let mono = if channels <= 1 {
        samples
    } else {
        samples
            .chunks(channels)
            .map(|f| f.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    Ok((mono, spec.sample_rate))
}
