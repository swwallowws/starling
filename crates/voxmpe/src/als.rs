//! The analysis as an Ableton Live set: one MIDI track whose clip carries each
//! note's bend as Live's own per-note pitch expression. Live's MIDI file import
//! drops MPE, so this is how the curves reach Live.

use anyhow::{anyhow, Result};
use expressive_liveset::{
    template_tracks, write, Clip, Note, Scene, Set, TimeSig, Track, TEMPLATE,
};
use voxmpe_core::types::Analysis;

/// The set's tempo. At 120 BPM a beat is half a second, so the clip lines up
/// with the take second for second.
pub const BPM: f64 = 120.0;
const BEATS_PER_S: f64 = BPM / 60.0;

/// One clip holding every note, from the start of the take.
pub fn clip(analysis: &Analysis, name: &str, duration_s: f32) -> Clip {
    let beats = |s: f32| s as f64 * BEATS_PER_S;
    let notes: Vec<Note> = analysis
        .notes
        .iter()
        .map(|n| Note {
            pitch: n.pitch,
            start: beats(n.start),
            dur: beats(n.end) - beats(n.start),
            // Same scaling as the MIDI export, so both files agree.
            velocity: ((n.velocity * 126.0).round() as u8 + 1).clamp(1, 127),
            pitch_curve: n
                .bend
                .iter()
                .map(|p| (beats(p.time) - beats(n.start), p.value))
                .collect(),
        })
        .collect();
    let last_end = notes.iter().map(|n| n.start + n.dur).fold(0.0, f64::max);
    Clip {
        name: name.to_string(),
        start: 0.0,
        length: beats(duration_s).max(last_end),
        time_sig: TimeSig {
            numerator: 4,
            denominator: 4,
        },
        notes,
    }
}

/// `.als` bytes: one track named after the take, the clip in the first Session
/// slot and on the Arrangement at beat 0.
pub fn als_bytes(analysis: &Analysis, name: &str, duration_s: f32) -> Result<Vec<u8>> {
    let c = clip(analysis, name, duration_s);
    let set = Set {
        tempo: BPM,
        tempo_changes: vec![],
        scenes: vec![Scene {
            name: name.to_string(),
            tempo: BPM,
        }],
        tracks: vec![Track {
            template: template_tracks(TEMPLATE)[0],
            name: name.to_string(),
            session: vec![Some(c.clone())],
            arrangement: Some(c),
        }],
    };
    write(&set, TEMPLATE).map_err(|e| anyhow!("writing .als: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use voxmpe_core::types::{CurvePoint, Note as VNote};

    fn analysis() -> Analysis {
        Analysis {
            frames: vec![],
            hop_s: 0.01,
            notes: vec![VNote {
                pitch: 60,
                pitch_center: 60.2,
                start: 1.5,
                end: 2.0,
                velocity: 1.0,
                bend: vec![
                    CurvePoint {
                        time: 1.5,
                        value: 0.2,
                    },
                    CurvePoint {
                        time: 1.75,
                        value: -0.5,
                    },
                ],
                amplitude: vec![],
                pressure: vec![],
                slide: vec![],
            }],
        }
    }

    /// Seconds become beats at 120 BPM; bend times become offsets from the
    /// note start; velocity scales like the MIDI export.
    #[test]
    fn notes_and_bends_become_beats() {
        let c = clip(&analysis(), "take", 4.0);
        assert_eq!(c.start, 0.0);
        assert_eq!(c.length, 8.0);
        assert_eq!(c.name, "take");
        assert_eq!(c.notes.len(), 1);
        let n = &c.notes[0];
        assert_eq!((n.pitch, n.start, n.dur, n.velocity), (60, 3.0, 1.0, 127));
        assert_eq!(n.pitch_curve, vec![(0.0, 0.2), (0.5, -0.5)]);
    }

    /// A note running past the reported duration still fits in the clip.
    #[test]
    fn the_clip_covers_the_last_note() {
        assert_eq!(clip(&analysis(), "take", 1.0).length, 4.0);
    }

    #[test]
    fn als_bytes_are_gzip() {
        let b = als_bytes(&analysis(), "take", 4.0).unwrap();
        assert_eq!(&b[..2], &[0x1f, 0x8b]);
    }
}
