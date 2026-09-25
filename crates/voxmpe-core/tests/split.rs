//! Browser pitch tracking runs in shares across workers. Any split, assembled,
//! must equal the native `track()` exactly.

use voxmpe_core::pitch::{self, CrepeModel};
use voxmpe_core::{frames_from_raw, track, AnalysisConfig};

const SR: u32 = 44_100;
const TINY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-tiny.onnx");

fn tiny() -> Option<CrepeModel> {
    if !std::path::Path::new(TINY).exists() {
        eprintln!("skipping: {TINY} missing (see models/README.md)");
        return None;
    }
    Some(CrepeModel::from_path(TINY).unwrap())
}

/// A4, a silent gap, then C5: the gap leaves frames out of the active list.
fn phrase() -> Vec<f32> {
    let n = (SR as f32 * 1.6) as usize;
    let mut phase = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / SR as f32;
            if (0.6..0.9).contains(&t) {
                return 0.0;
            }
            let hz = if t < 0.6 { 440.0 } else { 523.25 };
            phase += 2.0 * std::f32::consts::PI * hz / SR as f32;
            0.3 * (phase.sin() + 0.5 * (2.0 * phase).sin())
        })
        .collect()
}

#[test]
fn any_split_equals_native_track() {
    let Some(model) = tiny() else { return };
    let cfg = AnalysisConfig::default();
    let audio = phrase();
    let native = track(&audio, SR, &model, &cfg).unwrap();
    let prep = pitch::prepare(&audio, SR, cfg.segmentation.rms_floor);
    assert_eq!(prep.n_frames, native.frames.len());
    assert!(
        prep.active.len() < prep.n_frames,
        "the gap leaves frames out"
    );
    for shares in [1, 3, 7] {
        let size = prep.active.len().div_ceil(shares);
        let mut results = Vec::new();
        for idx in prep.active.chunks(size) {
            results.extend(model.pitch_frames(&prep.audio16, idx).unwrap());
        }
        let raw = pitch::assemble(prep.n_frames, &prep.active, &results).unwrap();
        let split = frames_from_raw(&raw, &audio, SR, &cfg);
        assert_eq!(
            format!("{:?}", split.frames),
            format!("{:?}", native.frames),
            "{shares} shares"
        );
        assert_eq!(split.hop_s, native.hop_s);
    }
}

#[test]
fn from_bytes_matches_from_path() {
    let Some(model) = tiny() else { return };
    let bytes = CrepeModel::from_bytes(&std::fs::read(TINY).unwrap()).unwrap();
    let prep = pitch::prepare(&phrase(), SR, 0.0);
    let idx = &prep.active[..40];
    assert_eq!(
        format!("{:?}", model.pitch_frames(&prep.audio16, idx).unwrap()),
        format!("{:?}", bytes.pitch_frames(&prep.audio16, idx).unwrap())
    );
}

#[test]
fn a_frame_past_the_end_is_an_error() {
    let Some(model) = tiny() else { return };
    let prep = pitch::prepare(&phrase(), SR, 0.0);
    let err = model
        .pitch_frames(&prep.audio16, &[prep.n_frames as u32])
        .unwrap_err();
    assert!(format!("{err}").contains("out of range"), "{err}");
}

#[test]
fn assemble_puts_results_in_frame_order_and_checks_lengths() {
    let raw = pitch::assemble(4, &[1, 3], &[(100.0, 0.9), (200.0, 0.8)]).unwrap();
    let got: Vec<_> = raw.iter().map(|r| (r.f0_hz, r.confidence)).collect();
    assert_eq!(got, [(0.0, 0.0), (100.0, 0.9), (0.0, 0.0), (200.0, 0.8)]);
    assert!(pitch::assemble(4, &[1, 3], &[(1.0, 1.0)]).is_err());
    assert!(pitch::assemble(2, &[5], &[(1.0, 1.0)]).is_err());
}

#[test]
fn silence_prepares_no_active_frames() {
    let prep = pitch::prepare(
        &vec![0.0; SR as usize],
        SR,
        AnalysisConfig::default().segmentation.rms_floor,
    );
    assert!(prep.n_frames > 0);
    assert!(prep.active.is_empty());
}
