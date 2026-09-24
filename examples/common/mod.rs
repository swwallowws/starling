//! Shared by the examples: flag parsing, model loading, note printout, MIDI output.

use anyhow::{bail, Context, Result};
use voxmidi_core::segment::{self, Cause};
use voxmidi_core::smf::{write_smf, OutputMode};
use voxmidi_core::{analyze, AnalysisConfig, CrepeModel};

const DEFAULT_MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/models/crepe-full.onnx");
const NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Flags shared by both examples.
pub const FLAGS_HELP: &str = "\
  --single-channel     plain channel-1 MIDI (±2 bend) instead of MPE
  --why                show which cue started each note
  --legato             preset for sung lyrics: fewer, smoother notes
  --hold-ms N          how long a new pitch must hold to start a note (default 90)
  --jump-hold-ms N     hold needed for a big jump; small moves need --hold-ms (default 90)
  --jump-cents N       interval counted as a big jump (default 300)
  --gap-ms N           silence that forces a new note (default 80)
  --split-cents N      pitch move that can start a note (default 70)
  --onset-delta N      loudness re-attack that starts a note, 0.6 = +60% (default 0.6)
  --no-onset           never split a note on loudness alone";

pub struct Opts {
    pub cfg: AnalysisConfig,
    pub single: bool,
    pub why: bool,
    /// Arguments not consumed here: positionals and example-specific flags.
    pub rest: Vec<String>,
}

pub fn parse_args() -> Result<Opts> {
    let mut o = Opts {
        cfg: AnalysisConfig::default(),
        single: false,
        why: false,
        rest: vec![],
    };
    // Apply --legato first so explicit knobs can override the preset.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--legato") {
        let s = &mut o.cfg.segmentation;
        s.hold_time_ms = 180.0;
        s.voicing_gap_ms = 150.0;
        s.onset_rms_delta = f32::INFINITY;
    }
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        let s = &mut o.cfg.segmentation;
        let mut num = |name: &str| -> Result<f32> {
            let v = it
                .next()
                .with_context(|| format!("{name} needs a number"))?;
            v.parse().with_context(|| format!("bad {name} {v}"))
        };
        match a.as_str() {
            "--single-channel" => o.single = true,
            "--why" => o.why = true,
            "--legato" => {}
            "--hold-ms" => s.hold_time_ms = num("--hold-ms")?,
            "--jump-hold-ms" => s.jump_hold_ms = num("--jump-hold-ms")?,
            "--jump-cents" => s.jump_cents = num("--jump-cents")?,
            "--gap-ms" => s.voicing_gap_ms = num("--gap-ms")?,
            "--split-cents" => s.split_cents = num("--split-cents")?,
            "--onset-delta" => s.onset_rms_delta = num("--onset-delta")?,
            "--no-onset" => s.onset_rms_delta = f32::INFINITY,
            "--help" | "-h" => bail!("flags:\n{FLAGS_HELP}"),
            _ => o.rest.push(a),
        }
    }
    Ok(o)
}

/// Load CREPE from `VOXMIDI_MODEL`, or `models/crepe-full.onnx` by default.
pub fn load_model() -> Result<CrepeModel> {
    let path = std::env::var("VOXMIDI_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
    CrepeModel::from_path(&path)
        .with_context(|| format!("no CREPE model at {path}; see README for how to get it"))
}

/// Analyze mono `audio`, print what was heard, and write `out` as MIDI.
pub fn transcribe(audio: &[f32], sr: u32, model: &CrepeModel, out: &str, o: &Opts) -> Result<()> {
    println!(
        "{:.1} s at {sr} Hz, analyzing...",
        audio.len() as f32 / sr as f32
    );
    let analysis = analyze(audio, sr, model, &o.cfg)?;
    // Same segmentation analyze() ran, repeated to read each note's cause.
    let spans = segment::segment(&analysis.frames, analysis.hop_s, &o.cfg.segmentation);
    println!("{} notes", analysis.notes.len());
    for (n, span) in analysis.notes.iter().zip(&spans) {
        let cents = (n.pitch_center - n.pitch as f64) * 100.0;
        let why = match (o.why, span.cause) {
            (false, _) => "",
            (true, Cause::Voicing) => "  after gap",
            (true, Cause::PitchChange) => "  pitch change",
            (true, Cause::Reattack) => "  re-attack",
        };
        println!(
            "  {:7.2}-{:7.2} s  {:<3}{:<2} ({:+5.1} c)  vel {:.2}{why}",
            n.start,
            n.end,
            NAMES[n.pitch as usize % 12],
            n.pitch as i32 / 12 - 1,
            cents,
            n.velocity,
        );
    }

    let mode = if o.single {
        OutputMode::SingleChannel { bend_range: 2 }
    } else {
        OutputMode::Mpe
    };
    write_smf(&analysis, mode, out)?;
    println!(
        "wrote {out} ({})",
        if o.single { "single channel" } else { "MPE" }
    );
    Ok(())
}
