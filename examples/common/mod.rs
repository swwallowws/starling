//! Shared by the examples: model loading, note printout, MIDI output.

use anyhow::{Context, Result};
use voxmidi_core::smf::{write_smf, OutputMode};
use voxmidi_core::{analyze, AnalysisConfig, CrepeModel};

const DEFAULT_MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/models/crepe-full.onnx");
const NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Load CREPE from `VOXMIDI_MODEL`, or `models/crepe-full.onnx` by default.
pub fn load_model() -> Result<CrepeModel> {
    let path = std::env::var("VOXMIDI_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
    CrepeModel::from_path(&path)
        .with_context(|| format!("no CREPE model at {path}; see README for how to get it"))
}

/// Analyze mono `audio`, print what was heard, and write `out` as MIDI.
pub fn transcribe(
    audio: &[f32],
    sr: u32,
    model: &CrepeModel,
    out: &str,
    single: bool,
) -> Result<()> {
    println!(
        "{:.1} s at {sr} Hz, analyzing...",
        audio.len() as f32 / sr as f32
    );
    let analysis = analyze(audio, sr, model, &AnalysisConfig::default())?;
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
    write_smf(&analysis, mode, out)?;
    println!(
        "wrote {out} ({})",
        if single { "single channel" } else { "MPE" }
    );
    Ok(())
}
