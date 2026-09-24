//! The two-stage API: track() once, transcribe() per settings change, must match
//! a fresh analyze() exactly.

use voxmpe_core::{analyze, track, transcribe, AnalysisConfig, CrepeModel};

const MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-full.onnx");
const SR: u32 = 44_100;

fn load_model() -> Option<CrepeModel> {
    if !std::path::Path::new(MODEL).exists() {
        eprintln!("skipping: {MODEL} not found (see models/README.md)");
        return None;
    }
    Some(CrepeModel::from_path(MODEL).expect("model"))
}

/// A4 for 0.5 s, 0.2 s silence, then a C5 for 0.5 s, with harmonics.
fn phrase() -> Vec<f32> {
    let mut out = Vec::new();
    for (secs, hz) in [(0.5f32, 440.0f32), (0.2, 0.0), (0.5, 523.25)] {
        let n = (secs * SR as f32) as usize;
        for i in 0..n {
            let t = i as f32 / SR as f32;
            let env = (t / 0.02).min(1.0).min(((secs - t) / 0.05).max(0.0));
            let p = 2.0 * std::f32::consts::PI * hz * t;
            out.push(if hz > 0.0 {
                0.3 * env * (p.sin() + 0.5 * (2.0 * p).sin())
            } else {
                0.0
            });
        }
    }
    out
}

#[test]
fn two_stage_matches_analyze() {
    let Some(model) = load_model() else { return };
    let cfg = AnalysisConfig::default();
    let audio = phrase();
    let whole = analyze(&audio, SR, &model, &cfg).unwrap();
    let staged = transcribe(&track(&audio, SR, &model, &cfg).unwrap(), &cfg);
    assert_eq!(format!("{:?}", whole.notes), format!("{:?}", staged.notes));
    assert_eq!(whole.notes.len(), 2);
}

#[test]
fn retranscribe_with_new_settings_matches_fresh_analyze() {
    let Some(model) = load_model() else { return };
    let audio = phrase();
    let frames = track(&audio, SR, &model, &AnalysisConfig::default()).unwrap();
    let mut cfg = AnalysisConfig::default();
    cfg.segmentation.hold_time_ms = 300.0;
    cfg.segmentation.voicing_gap_ms = 300.0;
    let fresh = analyze(&audio, SR, &model, &cfg).unwrap();
    let again = transcribe(&frames, &cfg);
    assert_eq!(format!("{:?}", fresh.notes), format!("{:?}", again.notes));
}
