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
//! `--why` shows what started each note; `--legato` and the `--*-ms` knobs tune
//! segmentation (run with `--help` for the list).

mod common;

use anyhow::{bail, Context, Result};

fn main() -> Result<()> {
    let opts = common::parse_args()?;
    let [input, output] = &opts.rest[..] else {
        bail!(
            "usage: wav_to_midi <in.wav> <out.mid> [flags]\n{}",
            common::FLAGS_HELP
        );
    };

    let model = common::load_model()?;
    let (audio, sr) = read_wav(input)?;
    common::transcribe(&audio, sr, &model, output, &opts)
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
