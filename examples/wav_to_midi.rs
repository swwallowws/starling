//! Sing into a WAV, get an expressive MIDI file out.
//!
//! ```text
//! cargo run --release --example wav_to_midi -- voice.wav voice.mid
//! cargo run --release --example wav_to_midi -- voice.wav voice.mid --single-channel
//! ```
//!
//! Default output is MPE (per-note pitch bend on channels 2-16, bend range ±48).
//! `--single-channel` writes plain channel-1 MIDI with a ±2 bend range for
//! instruments without MPE. Set `VOXMIDI_MODEL` to use a model outside `models/`.

use anyhow::{bail, Context, Result};
use voxmidi_core::smf::{write_smf, OutputMode};
use voxmidi_core::{analyze, AnalysisConfig, CrepeModel};

const DEFAULT_MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/models/crepe-full.onnx");
const NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let single = args.iter().any(|a| a == "--single-channel");
    let paths: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let [input, output] = paths[..] else {
        bail!("usage: wav_to_midi <in.wav> <out.mid> [--single-channel]");
    };

    let model_path = std::env::var("VOXMIDI_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
    let model = CrepeModel::from_path(&model_path)
        .with_context(|| format!("no CREPE model at {model_path}; see README for how to get it"))?;

    let (audio, sr) = read_wav(input)?;
    println!(
        "{input}: {:.1} s at {sr} Hz",
        audio.len() as f32 / sr as f32
    );

    let analysis = analyze(&audio, sr, &model, &AnalysisConfig::default())?;
    println!("{} notes", analysis.notes.len());
    for n in &analysis.notes {
        let cents = (n.pitch_center - n.pitch as f64) * 100.0;
        println!(
            "  {:7.2}-{:7.2} s  {:<3}{:<2} ({:+5.1} c)  vel {:.2}",
            n.start,
            n.end,
            NAMES[n.pitch as usize % 12],
            n.pitch as i32 / 12 - 1,
            cents,
            n.velocity,
        );
    }

    let mode = if single {
        OutputMode::SingleChannel { bend_range: 2 }
    } else {
        OutputMode::Mpe
    };
    write_smf(&analysis, mode, output)?;
    println!(
        "wrote {output} ({})",
        if single { "single channel" } else { "MPE" }
    );
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
