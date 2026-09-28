//! voxmpe: sing, get expressive MPE MIDI. `convert` for batch work; `studio`
//! (Task 7) for tuning by ear.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use voxmpe::cli::SettingsArgs;
use voxmpe::session::Session;

#[derive(Parser)]
#[command(name = "voxmpe", about = "Sing, get expressive MPE MIDI")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Convert a WAV recording to a MIDI file
    Convert {
        /// Input WAV (mono or stereo, any sample rate)
        input: PathBuf,
        /// Output MIDI path
        #[arg(short, long, default_value = "out.mid")]
        output: PathBuf,
        /// CREPE model path (default: models/crepe-full.onnx or $VOXMPE_MODEL)
        #[arg(long)]
        model: Option<PathBuf>,
        #[command(flatten)]
        settings: SettingsArgs,
    },
    /// Open the studio in your browser: record or open takes, tune by ear, export
    Studio {
        /// A WAV to open right away
        take: Option<PathBuf>,
        /// CREPE model path (default: models/crepe-full.onnx or $VOXMPE_MODEL)
        #[arg(long)]
        model: Option<PathBuf>,
        /// First port to try (the next free one is used if busy)
        #[arg(long, default_value_t = 7878)]
        port: u16,
        /// Folder for recordings and exports
        #[arg(long, default_value = "takes")]
        takes: PathBuf,
        /// Don't open the browser
        #[arg(long)]
        no_open: bool,
    },
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Convert {
            input,
            output,
            model,
            settings,
        } => convert(input, output, model, settings),
        Cmd::Studio {
            take,
            model,
            port,
            takes,
            no_open,
        } => studio(take, model, port, takes, no_open),
    }
}

fn convert(
    input: PathBuf,
    output: PathBuf,
    model: Option<PathBuf>,
    args: SettingsArgs,
) -> Result<()> {
    let settings = args.to_settings()?;
    let model = voxmpe::model::load_model(model.as_deref())?;
    let wav = std::fs::read(&input).with_context(|| format!("reading {}", input.display()))?;
    let name = input
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let session = Session::load(&name, wav, &model)?;
    if let Some(w) = &session.info().warning {
        eprintln!("warning: {w}");
    }
    let rendered = session.render(&settings)?;
    for n in &rendered.notes {
        eprintln!(
            "  {:7.2}-{:7.2} s  note {:>3}  {}",
            n.start, n.end, n.pitch, n.cause
        );
    }
    std::fs::write(&output, session.export_mid(&settings)?)
        .with_context(|| format!("writing {}", output.display()))?;
    eprintln!("{} notes -> {}", rendered.notes.len(), output.display());
    Ok(())
}

fn studio(
    take: Option<PathBuf>,
    model: Option<PathBuf>,
    port: u16,
    takes: PathBuf,
    no_open: bool,
) -> Result<()> {
    let model = voxmpe::model::load_model(model.as_deref())?;
    let mut state = voxmpe::server::State::new(Some(model), takes);
    if let Some(p) = take {
        state
            .preload(&p)
            .with_context(|| format!("opening {}", p.display()))?;
    }
    let (server, port) = voxmpe::server::bind(port)?;
    let url = format!("http://127.0.0.1:{port}/");
    println!("Starling studio: {url}  (Ctrl+C to stop)");
    if !no_open {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    voxmpe::server::serve(&server, &mut state);
    Ok(())
}
