//! SMF writer: the tick-0 setup a synth needs to decode the file correctly.
//! No model needed; builds an `Analysis` by hand and reads the file back.

use midly::{MidiMessage, Smf, TrackEventKind};
use voxmpe_core::smf::{write_smf, OutputMode};
use voxmpe_core::{Analysis, CurvePoint, Note};

fn one_note() -> Analysis {
    Analysis {
        frames: vec![],
        hop_s: 0.01,
        notes: vec![Note {
            pitch: 69,
            pitch_center: 69.2,
            start: 0.0,
            end: 0.5,
            velocity: 0.8,
            bend: vec![CurvePoint {
                time: 0.0,
                value: 0.2,
            }],
            amplitude: vec![CurvePoint {
                time: 0.0,
                value: 0.8,
            }],
            pressure: vec![],
            slide: vec![],
        }],
    }
}

/// (channel, controller, value) for every CC, plus the channel of the first note-on.
fn read_back(mode: OutputMode, name: &str) -> (Vec<(u8, u8, u8)>, u8) {
    let path = std::env::temp_dir().join(format!("voxmidi_{name}_{}.mid", std::process::id()));
    let path_str = path.to_str().unwrap();
    write_smf(&one_note(), mode, path_str).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).ok();
    let smf = Smf::parse(&bytes).unwrap();

    let mut ccs = Vec::new();
    let mut note_ch = None;
    for ev in &smf.tracks[0] {
        if let TrackEventKind::Midi { channel, message } = ev.kind {
            match message {
                MidiMessage::Controller { controller, value } => {
                    ccs.push((channel.as_int(), controller.as_int(), value.as_int()))
                }
                MidiMessage::NoteOn { .. } if note_ch.is_none() => note_ch = Some(channel.as_int()),
                _ => {}
            }
        }
    }
    (ccs, note_ch.expect("a note-on"))
}

/// The value written for RPN `rpn` on `channel`, if any.
fn rpn_value(ccs: &[(u8, u8, u8)], channel: u8, rpn: u8) -> Option<u8> {
    let on_ch: Vec<(u8, u8)> = ccs
        .iter()
        .filter(|c| c.0 == channel)
        .map(|c| (c.1, c.2))
        .collect();
    on_ch
        .windows(3)
        .find(|w| w[0] == (101, 0) && w[1] == (100, rpn) && w[2].0 == 6)
        .map(|w| w[2].1)
}

#[test]
fn mpe_file_announces_zone_and_bend_range() {
    let (ccs, note_ch) = read_back(OutputMode::Mpe, "mpe");

    // MPE Configuration Message: master channel (0), 15 member channels.
    assert_eq!(rpn_value(&ccs, 0, 6), Some(15));
    // It must come before any bend-range RPN, since it resets them.
    let mcm_at = ccs.iter().position(|c| c.1 == 100 && c.2 == 6).unwrap();
    let first_range_at = ccs.iter().position(|c| c.1 == 100 && c.2 == 0).unwrap();
    assert!(mcm_at < first_range_at);

    for ch in 0..16 {
        assert_eq!(
            rpn_value(&ccs, ch, 0),
            Some(48),
            "bend range on channel {ch}"
        );
    }
    assert!(
        (1..=15).contains(&note_ch),
        "note on a member channel, got {note_ch}"
    );
}

#[test]
fn single_channel_file_has_no_mpe_config() {
    let (ccs, note_ch) = read_back(OutputMode::SingleChannel { bend_range: 2 }, "single");
    assert_eq!(rpn_value(&ccs, 0, 6), None);
    assert_eq!(rpn_value(&ccs, 0, 0), Some(2));
    assert_eq!(note_ch, 0);
}
