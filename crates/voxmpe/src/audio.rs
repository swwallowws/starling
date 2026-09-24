//! WAV decoding for takes: files on disk and browser uploads.

use std::io::Cursor;

use anyhow::{Context, Result};

/// Decode WAV bytes to mono f32 + sample rate (multichannel is downmixed).
pub fn decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32)> {
    let mut reader =
        hound::WavReader::new(Cursor::new(bytes)).context("not a readable WAV file")?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
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
    let mono = if channels == 1 {
        samples
    } else {
        samples
            .chunks(channels)
            .map(|f| f.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    Ok((mono, spec.sample_rate))
}

/// Largest absolute sample value.
pub fn peak(audio: &[f32]) -> f32 {
    audio.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hound_wav(
        spec: hound::WavSpec,
        write: impl Fn(&mut hound::WavWriter<&mut Cursor<Vec<u8>>>),
    ) -> Vec<u8> {
        let mut cur = Cursor::new(Vec::new());
        {
            let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
            write(&mut w);
            w.finalize().unwrap();
        }
        cur.into_inner()
    }

    #[test]
    fn stereo_int16_is_downmixed() {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let bytes = hound_wav(spec, |w| {
            w.write_sample(16384i16).unwrap();
            w.write_sample(0i16).unwrap();
        });
        let (mono, sr) = decode_wav(&bytes).unwrap();
        assert_eq!(sr, 48_000);
        assert_eq!(mono.len(), 1);
        assert!((mono[0] - 0.25).abs() < 1e-4);
    }

    /// Exactly what studio-ui/src/wav.ts writes: RIFF, 16-byte fmt chunk,
    /// format 3 (IEEE float), mono, 32-bit, then the data chunk.
    #[test]
    fn decodes_the_browser_float_wav_layout() {
        let samples = [0.5f32, -0.25, 0.0];
        let sr = 96_000u32;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + samples.len() as u32 * 4).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&3u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&(sr * 4).to_le_bytes());
        b.extend_from_slice(&4u16.to_le_bytes());
        b.extend_from_slice(&32u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(samples.len() as u32 * 4).to_le_bytes());
        for s in samples {
            b.extend_from_slice(&s.to_le_bytes());
        }
        let (mono, got_sr) = decode_wav(&b).unwrap();
        assert_eq!(got_sr, sr);
        assert_eq!(mono, samples);
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(decode_wav(b"definitely not audio").is_err());
    }
}
