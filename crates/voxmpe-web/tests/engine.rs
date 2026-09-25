//! The browser engine must give exactly what the native studio gives.

use std::io::Cursor;

use voxmpe::session::Session;
use voxmpe::settings::Settings;
use voxmpe_core::{types::Frame, CrepeModel, Frames};
use voxmpe_web::{decode_frames, encode_frames, Engine, Pitch, MAX_SECONDS};

const TINY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-tiny.onnx");

fn tiny() -> Option<Vec<u8>> {
    std::fs::read(TINY)
        .map_err(|_| eprintln!("skipping: {TINY} missing (see models/README.md)"))
        .ok()
}

fn wav(samples: &[f32], sr: u32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sr,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for &s in samples {
            w.write_sample((s * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }
    cur.into_inner()
}

/// A4, a short silence, then C5 with vibrato.
fn phrase() -> Vec<u8> {
    let sr = 44_100;
    let mut phase = 0.0f32;
    let samples: Vec<f32> = (0..(sr as f32 * 1.4) as usize)
        .map(|i| {
            let t = i as f32 / sr as f32;
            if (0.5..0.7).contains(&t) {
                return 0.0;
            }
            let hz = if t < 0.5 {
                440.0
            } else {
                523.25 * (1.0 + 0.01 * (t * 35.0).sin())
            };
            phase += 2.0 * std::f32::consts::PI * hz / sr as f32;
            0.3 * (phase.sin() + 0.5 * (2.0 * phase).sin())
        })
        .collect();
    wav(&samples, sr)
}

/// Analyze the loaded take with `shares` pitch workers, as the page does.
fn analyze(engine: &mut Engine, pitch: &Pitch, shares: usize) -> String {
    let prep = engine.prepared().unwrap().clone();
    let size = prep.active.len().div_ceil(shares).max(1);
    let mut results = Vec::new();
    for idx in prep.active.chunks(size) {
        results.extend(pitch.run(&prep.audio16, idx).unwrap());
    }
    engine.finish(&results).unwrap()
}

fn tuned() -> Settings {
    let scl = voxmpe::tunings::presets()
        .into_iter()
        .find(|p| p.id == "31-edo")
        .unwrap()
        .scl;
    Settings {
        tuning_name: Some("31-edo".into()),
        tuning_scl: Some(scl),
        smoothing: 0.5,
        ..Settings::default()
    }
}

#[test]
fn the_browser_engine_matches_the_native_session() {
    let Some(model) = tiny() else { return };
    let native =
        Session::load("phrase", phrase(), &CrepeModel::from_bytes(&model).unwrap()).unwrap();
    let pitch = Pitch::new(&model).unwrap();
    let mut engine = Engine::new();
    engine.load("phrase", phrase()).unwrap();
    let info = analyze(&mut engine, &pitch, 3);
    assert_eq!(info, serde_json::to_string(&native.info()).unwrap());
    let s = tuned();
    let json = serde_json::to_string(&s).unwrap();
    assert_eq!(
        engine.render(&json).unwrap(),
        serde_json::to_string(&native.render(&s).unwrap()).unwrap()
    );
    assert_eq!(
        engine.export(&json, "mid").unwrap(),
        native.export_mid(&s).unwrap()
    );
    assert_eq!(
        engine.export(&json, "als").unwrap(),
        native.export_als(&s).unwrap()
    );
}

#[test]
fn a_restored_take_needs_no_analysis() {
    let Some(model) = tiny() else { return };
    let pitch = Pitch::new(&model).unwrap();
    let mut first = Engine::new();
    first.load("phrase", phrase()).unwrap();
    let info = analyze(&mut first, &pitch, 2);
    let cached = first.frames().unwrap();
    let mut again = Engine::new();
    assert_eq!(again.restore("phrase", phrase(), &cached).unwrap(), info);
    assert_eq!(again.render("{}").unwrap(), first.render("{}").unwrap());
}

#[test]
fn silence_opens_with_no_active_frames() {
    let mut engine = Engine::new();
    engine
        .load("quiet", wav(&vec![0.0; 44_100], 44_100))
        .unwrap();
    assert!(engine.prepared().unwrap().active.is_empty());
    let info: serde_json::Value = serde_json::from_str(&engine.finish(&[]).unwrap()).unwrap();
    assert!(info["warning"].as_str().unwrap().contains("quiet"));
    assert!(engine.render("{}").unwrap().contains("\"notes\":[]"));
}

#[test]
fn frames_survive_encoding() {
    let f = Frames {
        hop_s: 0.01,
        frames: vec![
            Frame {
                time: 0.0,
                f0_hz: 440.0,
                confidence: 0.9,
                rms: 0.2,
                centroid_hz: 900.0,
                voiced: true,
            },
            Frame {
                time: 0.01,
                f0_hz: 0.0,
                confidence: 0.0,
                rms: 0.0,
                centroid_hz: 0.0,
                voiced: false,
            },
        ],
    };
    let back = decode_frames(&encode_frames(&f)).unwrap();
    assert_eq!(format!("{:?}", back.frames), format!("{:?}", f.frames));
    assert_eq!(back.hop_s, f.hop_s);
    assert!(decode_frames(&[]).is_err());
    assert!(format!("{}", decode_frames(&[0.01, 1.0]).unwrap_err()).contains("damaged"));
}

#[test]
fn takes_over_ten_minutes_are_refused() {
    let long = vec![0.0f32; (8_000.0 * (MAX_SECONDS + 1.0)) as usize];
    let err = Engine::new().load("long", wav(&long, 8_000)).unwrap_err();
    assert!(format!("{err}").contains("10 minutes"), "{err}");
}

#[test]
fn bad_input_reads_clearly() {
    let mut engine = Engine::new();
    assert!(format!("{}", engine.render("{}").unwrap_err()).contains("no take is open"));
    assert!(format!("{}", engine.finish(&[]).unwrap_err()).contains("no take is being analyzed"));
    engine.load("quiet", wav(&vec![0.0; 8_000], 8_000)).unwrap();
    engine.finish(&[]).unwrap();
    assert!(
        format!("{}", engine.export("{}", "wav").unwrap_err()).contains("unknown export format")
    );
    let bad = r#"{"tuning_scl": "not a scale"}"#;
    assert!(format!("{}", engine.render(bad).unwrap_err()).starts_with("tuning"));
}
