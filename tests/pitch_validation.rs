//! Gate #2: confirm tract-onnx reproduces CREPE f0 from Rust on synthetic tones.
//! Mirrors the python validation in scripts/export_crepe.py.

use voxmidi_core::CrepeModel;

const MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/models/crepe-full.onnx");

fn sine(freq: f32, secs: f32, sr: u32) -> Vec<f32> {
    let n = (secs * sr as f32) as usize;
    (0..n)
        .map(|i| 0.5 * (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin())
        .collect()
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

#[test]
fn tract_reproduces_f0() {
    if !std::path::Path::new(MODEL).exists() {
        eprintln!("skipping: {MODEL} not found (see README for how to get the model)");
        return;
    }
    let model = CrepeModel::from_path(MODEL).expect("load model");
    for &target in &[110.0f32, 220.0, 440.0, 880.0] {
        let sr = 44_100;
        let audio = sine(target, 1.0, sr);
        let frames = model.track(&audio, sr).expect("track");
        assert!(frames.len() > 50, "too few frames");
        // drop edge frames
        let inner = &frames[5..frames.len() - 5];
        let f0 = median(inner.iter().map(|f| f.f0_hz).collect());
        let conf = median(inner.iter().map(|f| f.confidence).collect());
        let err_cents = 1200.0 * (f0 / target).log2();
        println!("{target:7.1} -> {f0:8.2} Hz  conf {conf:.3}  ({err_cents:+.1} cents)");
        assert!(
            err_cents.abs() < 35.0,
            "{target} Hz off by {err_cents} cents"
        );
        assert!(conf > 0.5, "{target} Hz low confidence {conf}");
    }
}
