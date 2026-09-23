//! Segmentation regression tests (SPEC §8): the cases that break first when
//! thresholds drift. Signals are synthetic but voice-like (harmonics + vibrato
//! + amplitude envelope). All share one model load.

use voxmidi_core::{analyze, AnalysisConfig, CrepeModel};

const MODEL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/models/crepe-full.onnx");
const SR: u32 = 44_100;

/// Load the model, or `None` (test skips) when it hasn't been downloaded.
fn load_model() -> Option<CrepeModel> {
    if !std::path::Path::new(MODEL).exists() {
        eprintln!("skipping: {MODEL} not found (see README for how to get the model)");
        return None;
    }
    Some(CrepeModel::from_path(MODEL).expect("model"))
}

/// Additive-harmonic tone with time-varying frequency `f(t)` and envelope `env(t)`.
fn synth<F, E>(secs: f32, f: F, env: E) -> Vec<f32>
where
    F: Fn(f32) -> f32,
    E: Fn(f32) -> f32,
{
    let n = (secs * SR as f32) as usize;
    let mut out = Vec::with_capacity(n);
    let mut phase = 0.0f32;
    let dt = 1.0 / SR as f32;
    for i in 0..n {
        let t = i as f32 * dt;
        let freq = f(t);
        phase += 2.0 * std::f32::consts::PI * freq * dt;
        // a few harmonics, rolling off, for a voice-like spectrum
        let s = phase.sin() + 0.5 * (2.0 * phase).sin() + 0.25 * (3.0 * phase).sin();
        out.push(0.3 * env(t) * s);
    }
    out
}

fn midi_to_hz(m: f32) -> f32 {
    440.0 * 2.0f32.powf((m - 69.0) / 12.0)
}

/// Smooth attack/release envelope so onsets are realistic.
fn ar(t: f32, dur: f32) -> f32 {
    let a = 0.02;
    let r = 0.05;
    if t < a {
        t / a
    } else if t > dur - r {
        ((dur - t) / r).max(0.0)
    } else {
        1.0
    }
}

fn note_pitches(audio: &[f32], model: &CrepeModel) -> Vec<u8> {
    let r = analyze(audio, SR, model, &AnalysisConfig::default()).unwrap();
    r.notes.iter().map(|n| n.pitch).collect()
}

#[test]
fn segmentation_cases() {
    let Some(model) = load_model() else { return };

    // 1. Sustained note -> exactly one note at A4 (69).
    let sustained = synth(0.8, |_| 440.0, |t| ar(t, 0.8));
    let p = note_pitches(&sustained, &model);
    println!("sustained: {p:?}");
    assert_eq!(p.len(), 1, "sustained should be ONE note");
    assert_eq!(p[0], 69);

    // 2. Vibrato (6 Hz, ±50 cents around A4) -> still ONE note. The key case.
    let vibrato = synth(
        1.2,
        |t| 440.0 * 2.0f32.powf(0.5 / 12.0 * (2.0 * std::f32::consts::PI * 6.0 * t).sin()),
        |t| ar(t, 1.2),
    );
    let p = note_pitches(&vibrato, &model);
    println!("vibrato: {p:?}");
    assert_eq!(p.len(), 1, "vibrato must stay ONE note, got {p:?}");
    assert_eq!(p[0], 69);

    // 3. Legato slide A4 -> C5 -> TWO notes (69 then 72).
    let slide = synth(
        1.0,
        |t| {
            let (a, c) = (midi_to_hz(69.0), midi_to_hz(72.0));
            if t < 0.45 {
                a
            } else if t < 0.55 {
                let x = (t - 0.45) / 0.1;
                midi_to_hz(69.0 + 3.0 * x) // glide in semitone space
            } else {
                c
            }
        },
        |t| ar(t, 1.0),
    );
    let p = note_pitches(&slide, &model);
    println!("slide: {p:?}");
    assert_eq!(p.len(), 2, "slide should split into TWO notes, got {p:?}");
    assert_eq!((p[0], p[1]), (69, 72));

    // 4. Re-articulated SAME pitch (amplitude dip + re-attack) -> TWO notes.
    let rearticulate = synth(
        1.0,
        |_| 440.0,
        |t| {
            // two AR notes back-to-back at the same pitch
            if t < 0.48 {
                ar(t, 0.48)
            } else {
                ar(t - 0.5, 0.5)
            }
        },
    );
    let p = note_pitches(&rearticulate, &model);
    println!("rearticulate: {p:?}");
    assert_eq!(p.len(), 2, "re-articulation should be TWO notes, got {p:?}");
    assert_eq!((p[0], p[1]), (69, 69));

    // 5. Two notes separated by silence -> TWO notes.
    let gap = {
        let mut a = synth(0.4, |_| midi_to_hz(67.0), |t| ar(t, 0.4));
        a.extend(vec![0.0f32; (0.2 * SR as f32) as usize]); // 200 ms silence
        a.extend(synth(0.4, |_| midi_to_hz(74.0), |t| ar(t, 0.4)));
        a
    };
    let p = note_pitches(&gap, &model);
    println!("gap: {p:?}");
    assert_eq!(p.len(), 2, "silence gap should give TWO notes, got {p:?}");
    assert_eq!((p[0], p[1]), (67, 74));
}

/// THE SEAM: the fractional pitch center must survive on `Note::pitch_center`
/// (not just the rounded 12-TET `pitch`). A tone tuned ~30 cents sharp of A4
/// must round to 69 yet expose a center around 69.3 — proving the fraction is
/// not discarded, so a microtonal consumer could requantize it.
#[test]
fn fractional_pitch_center_is_preserved() {
    let Some(model) = load_model() else { return };
    let sharp = 440.0 * 2.0f32.powf(30.0 / 1200.0); // A4 + 30 cents
    let audio = synth(0.8, |_| sharp, |t| ar(t, 0.8));
    let r = analyze(&audio, SR, &model, &AnalysisConfig::default()).unwrap();
    assert_eq!(r.notes.len(), 1);
    let note = &r.notes[0];
    assert_eq!(note.pitch, 69, "rounds to A4 in 12-TET");
    let cents_off = (note.pitch_center - 69.0) * 100.0;
    println!(
        "pitch_center = {:.4} ({:+.1} cents)",
        note.pitch_center, cents_off
    );
    assert!(
        (cents_off - 30.0).abs() < 15.0,
        "fractional center should be ~+30c off A4, got {cents_off:+.1}c"
    );
}
