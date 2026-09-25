use std::io::Cursor;

use midly::{MidiMessage, Smf, TrackEventKind};
use voxmpe::session::Session;
use voxmpe::settings::Settings;
use voxmpe_core::CrepeModel;

const SR: u32 = 44_100;

fn model() -> Option<CrepeModel> {
    if !std::path::Path::new(voxmpe::model::DEFAULT_MODEL).exists() {
        eprintln!("skipping: model not found (see models/README.md)");
        return None;
    }
    Some(voxmpe::model::load_model(None).unwrap())
}

fn wav(samples: &[f32]) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for &s in samples {
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    }
    cur.into_inner()
}

/// A4 for 0.5 s then C5 for 0.5 s, joined with no gap (a 300-cent step), at `amp`.
fn step(amp: f32) -> Vec<f32> {
    let n = SR as usize;
    let mut phase = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / SR as f32;
            let hz = if t < 0.5 { 440.0 } else { 523.25 };
            phase += 2.0 * std::f32::consts::PI * hz / SR as f32;
            let env = (t / 0.02).min(1.0).min(((1.0 - t) / 0.05).max(0.0));
            amp * env * (phase.sin() + 0.5 * (2.0 * phase).sin())
        })
        .collect()
}

fn note_ons(mid: &[u8]) -> usize {
    let smf = Smf::parse(mid).unwrap();
    smf.tracks[0]
        .iter()
        .filter(|e| {
            matches!(
                e.kind,
                TrackEventKind::Midi {
                    message: MidiMessage::NoteOn { .. },
                    ..
                }
            )
        })
        .count()
}

#[test]
fn render_responds_to_settings_without_retracking() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let default = s.render(&Settings::default()).unwrap();
    let pitches: Vec<u8> = default.notes.iter().map(|n| n.pitch).collect();
    assert_eq!(pitches, vec![69, 72]);
    assert_eq!(default.notes[1].cause, "pitch");
    let wide = s
        .render(&Settings {
            split_cents: 400.0,
            ..Settings::default()
        })
        .unwrap();
    assert_eq!(wide.notes.len(), 1, "a 300c step must not split at 400c");
    assert_eq!(wide.flags, "--split-cents 400");
}

#[test]
fn export_is_a_valid_mpe_file_with_every_note() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let mid = s.export_mid(&Settings::default()).unwrap();
    assert_eq!(note_ons(&mid), 2);
}

#[test]
fn silent_take_warns_and_still_exports() {
    let Some(m) = model() else { return };
    let s = Session::load("quiet", wav(&step(0.001)), &m).unwrap();
    assert!(s.info().warning.is_some());
    let r = s.render(&Settings::default()).unwrap();
    assert!(r.notes.is_empty());
    assert_eq!(note_ons(&s.export_mid(&Settings::default()).unwrap()), 0);
}

#[test]
fn very_short_take_is_fine() {
    let Some(m) = model() else { return };
    let s = Session::load("short", wav(&step(0.3)[..SR as usize / 20]), &m).unwrap();
    assert!(s.render(&Settings::default()).is_ok());
}

#[test]
fn bad_tuning_is_an_error_not_a_panic() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let bad = Settings {
        tuning_scl: Some("not a scale".into()),
        ..Settings::default()
    };
    assert!(s.render(&bad).is_err());
}

#[test]
fn info_has_one_contour_point_per_frame() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let info = s.info();
    assert_eq!(info.contour.len(), info.loudness.len());
    assert!((info.duration_s - 1.0).abs() < 0.01);
    assert!(info.loudness.iter().all(|&l| (0.0..=1.0).contains(&l)));
}

#[test]
fn full_correction_flattens_each_notes_bend() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let flat = s
        .render(&Settings {
            correction: 1.0,
            vibrato: 0.0,
            ..Settings::default()
        })
        .unwrap();
    for n in &flat.notes {
        let vals: Vec<f32> = n.bend.iter().map(|p| p[1]).collect();
        if vals.len() < 4 {
            continue;
        }
        let mid = &vals[vals.len() / 4..3 * vals.len() / 4];
        let (lo, hi) = mid
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), &v| (a.min(v), b.max(v)));
        assert!(
            hi - lo < 0.05,
            "note {} still moves {:.3} semitones",
            n.pitch,
            hi - lo
        );
    }
}

#[test]
fn the_exported_midi_has_exactly_the_notes_the_studio_shows() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let settings = Settings {
        hold_ms: 95.0,
        jump_hold_ms: 175.0,
        jump_cents: 260.0,
        gap_ms: 285.0,
        split_cents: 90.0,
        onset_delta: Some(1.45),
        tuning_name: Some("31-edo".into()),
        tuning_scl: Some(
            voxmpe::tunings::presets()
                .into_iter()
                .find(|p| p.id == "31-edo")
                .unwrap()
                .scl,
        ),
        smoothing: 0.5,
        correction: 0.5,
        ..Settings::default()
    };
    let shown: Vec<u8> = s
        .render(&settings)
        .unwrap()
        .notes
        .iter()
        .map(|n| n.pitch)
        .collect();
    let mid = s.export_mid(&settings).unwrap();
    let smf = Smf::parse(&mid).unwrap();
    let exported: Vec<u8> = smf.tracks[0]
        .iter()
        .filter_map(|e| match e.kind {
            TrackEventKind::Midi {
                message: MidiMessage::NoteOn { key, .. },
                ..
            } => Some(key.as_int()),
            _ => None,
        })
        .collect();
    assert!(!shown.is_empty());
    assert_eq!(exported, shown);
}

/// The .als carries the same notes as the studio, each with its bend as a
/// per-note pitch curve (once in the Session clip, once in the Arrangement).
#[test]
fn the_live_set_has_the_notes_and_curves_the_studio_shows() {
    let Some(m) = model() else { return };
    let s = Session::load("step", wav(&step(0.3)), &m).unwrap();
    let settings = Settings::default();
    let shown = s.render(&settings).unwrap().notes;
    let mut xml = String::new();
    std::io::Read::read_to_string(
        &mut flate2::read::GzDecoder::new(&s.export_als(&settings).unwrap()[..]),
        &mut xml,
    )
    .unwrap();
    assert!(!shown.is_empty());
    assert_eq!(xml.matches("<MidiNoteEvent ").count(), 2 * shown.len());
    let curved = shown.iter().filter(|n| !n.bend.is_empty()).count();
    assert!(curved > 0);
    assert_eq!(xml.matches("<PerNoteEventList ").count(), 2 * curved);
    let points: usize = shown.iter().map(|n| n.bend.len()).sum();
    assert_eq!(xml.matches("<PerNoteEvent ").count(), 2 * points);
}

/// The browser rebuilds a session from frames analyzed elsewhere: it must be
/// the same take as one loaded natively.
#[test]
fn a_session_from_frames_matches_a_loaded_one() {
    let Some(m) = model() else { return };
    let w = wav(&step(0.3));
    let loaded = Session::load("step", w.clone(), &m).unwrap();
    let rebuilt = Session::from_frames("step", w, loaded.frames().clone()).unwrap();
    let s = Settings::default();
    assert_eq!(
        serde_json::to_string(&loaded.info()).unwrap(),
        serde_json::to_string(&rebuilt.info()).unwrap()
    );
    assert_eq!(
        loaded.export_mid(&s).unwrap(),
        rebuilt.export_mid(&s).unwrap()
    );
    assert_eq!(
        loaded.export_als(&s).unwrap(),
        rebuilt.export_als(&s).unwrap()
    );
}
