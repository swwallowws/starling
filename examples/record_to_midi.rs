//! Record your voice from the default mic, then transcribe it to MIDI.
//!
//! ```text
//! cargo run --release --example record_to_midi -- take1
//! cargo run --release --example record_to_midi -- take1 --single-channel
//! cargo run --release --example record_to_midi -- take1 --seconds 8
//! ```
//!
//! Records until you press Enter (or for `--seconds N`, for when there's no
//! interactive stdin), then writes `take1.wav` (the raw take, so you
//! can re-run it through `wav_to_midi`) and `take1.mid`. Sing one note at a time:
//! the engine is monophonic.

mod common;

use std::io::BufRead;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut single = false;
    let mut seconds: Option<f32> = None;
    let mut names = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--single-channel" => single = true,
            "--seconds" => {
                let v = it.next().context("--seconds needs a number")?;
                seconds = Some(v.parse().with_context(|| format!("bad --seconds {v}"))?);
            }
            _ => names.push(a),
        }
    }
    let [base] = names[..] else {
        bail!(
            "usage: record_to_midi <name> [--seconds N] [--single-channel]  (writes <name>.wav + <name>.mid)"
        );
    };

    // Load first so the (slow) model setup doesn't happen after you've sung.
    let model = common::load_model()?;

    let device = cpal::default_host()
        .default_input_device()
        .context("no input device (check the mic and its permission for this terminal)")?;
    let config = device.default_input_config()?;
    let sr = config.sample_rate().0;
    let channels = config.channels() as usize;
    println!("mic: {} ({sr} Hz)", device.name().unwrap_or_default());

    let buf = Arc::new(Mutex::new(Vec::<f32>::new()));
    let stream = match config.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config.into(), channels, buf.clone())?,
        SampleFormat::I16 => build::<i16>(&device, &config.into(), channels, buf.clone())?,
        SampleFormat::I32 => build::<i32>(&device, &config.into(), channels, buf.clone())?,
        SampleFormat::U16 => build::<u16>(&device, &config.into(), channels, buf.clone())?,
        other => bail!("unsupported mic sample format {other:?}"),
    };
    stream.play()?;
    match seconds {
        Some(secs) => {
            println!("recording for {secs} s... sing now");
            std::thread::sleep(std::time::Duration::from_secs_f32(secs));
        }
        None => {
            println!("recording... press Enter to stop");
            std::io::stdin().lock().lines().next();
        }
    }
    drop(stream);

    let audio = std::mem::take(&mut *buf.lock().unwrap());
    if audio.is_empty() {
        bail!("recorded nothing; if on macOS, allow microphone access for this terminal");
    }
    let peak = audio.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak < 0.01 {
        println!("warning: very quiet take (peak {peak:.4}); is the right mic selected?");
    }

    let wav = format!("{base}.wav");
    write_wav(&wav, &audio, sr)?;
    println!("wrote {wav}");
    common::transcribe(&audio, sr, &model, &format!("{base}.mid"), single)
}

/// Input stream that downmixes each frame to mono f32 and appends it to `buf`.
fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    buf: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mut out = buf.lock().unwrap();
            for frame in data.chunks(channels) {
                let sum: f32 = frame.iter().map(|s| s.to_sample::<f32>()).sum();
                out.push(sum / channels as f32);
            }
        },
        |err| eprintln!("mic error: {err}"),
        None,
    )?;
    Ok(stream)
}

fn write_wav(path: &str, audio: &[f32], sr: u32) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sr,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec)?;
    for &s in audio {
        w.write_sample(s)?;
    }
    w.finalize()?;
    Ok(())
}
