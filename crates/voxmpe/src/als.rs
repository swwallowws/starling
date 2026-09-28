//! The analysis as an Ableton Live set: one MIDI track whose clip carries each
//! note's bend as Live's own per-note pitch expression. Live's MIDI file import
//! drops MPE, so this is how the curves reach Live.
//!
//! In 12-TET the notes sit on their 12-TET keys and the curves carry the whole
//! bend. With another tuning the set carries the tuning too (Live 12's
//! `<TuningSystems>`), the notes are steps of it and the curves carry only the
//! glides and vibrato, measured from the tuned step. The step mapping is the
//! one of the studio's "MIDI + tuning for Live 12" export
//! (studio-ui/src/live-export.ts): MIDI note 0 plays step `lowest` counted
//! from the 1/1, which sits at the anchor.

use anyhow::{anyhow, Result};
use expressive_liveset::{
    template_tracks, write_tuned, Anchor, Clip, Note, Scene, Set, TimeSig, Track, TuningSystem,
    TEMPLATE,
};
use voxmpe_core::types::Analysis;

use crate::scala::Scale;
use crate::settings::Settings;

/// Live's MIDI notes.
pub const MIDI_KEYS: i64 = 128;
/// Standard MIDI note 0, 8.18 Hz: MIDI note 0 is never put below it.
const LOWEST_HZ: f64 = 8.1757989;

/// A scale's steps numbered from the anchor: step 0 is the 1/1 at `anchor_hz`,
/// step `n` the 1/1 a period up. Same numbers as `Steps` in studio-ui/src/scala.ts.
#[derive(Debug, Clone)]
pub struct Steps {
    /// Degrees in cents within one period, ascending, `[0] == 0`.
    pub degrees: Vec<f64>,
    pub period: f64,
    pub anchor_hz: f64,
}

impl Steps {
    pub fn new(scale: &Scale, anchor_hz: f64) -> Steps {
        let mut degrees = scale.degrees.clone();
        degrees.sort_by(|a, b| a.total_cmp(b));
        Steps {
            degrees,
            period: scale.period,
            anchor_hz,
        }
    }

    pub fn n(&self) -> i64 {
        self.degrees.len() as i64
    }

    /// Cents of step `s` above the anchor.
    pub fn cents(&self, s: i64) -> f64 {
        let k = s.div_euclid(self.n());
        k as f64 * self.period + self.degrees[s.rem_euclid(self.n()) as usize]
    }

    /// Step `s` as a fractional MIDI note.
    pub fn midi(&self, s: i64) -> f64 {
        hz_to_midi(self.anchor_hz * 2f64.powf(self.cents(s) / 1200.0))
    }

    /// The step a fractional MIDI pitch snaps to (the engine's snap, as a step).
    pub fn snap(&self, midi_pitch: f64) -> i64 {
        let cents = 1200.0 * (midi_to_hz(midi_pitch) / self.anchor_hz).log2();
        let k = (cents / self.period).floor();
        let reduced = cents - k * self.period;
        let k = k as i64;
        let mut best = 0usize;
        let mut best_err = (self.degrees[0] - reduced).abs();
        for (j, d) in self.degrees.iter().enumerate() {
            let err = (d - reduced).abs();
            if err < best_err {
                best_err = err;
                best = j;
            }
        }
        if (self.period - reduced).abs() < best_err {
            return (k + 1) * self.n();
        }
        k * self.n() + best as i64
    }
}

fn midi_to_hz(m: f64) -> f64 {
    440.0 * 2f64.powf((m - 69.0) / 12.0)
}

fn hz_to_midi(hz: f64) -> f64 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

/// The anchor's octave number in Live's naming, where middle C is C3.
pub fn anchor_octave(anchor_hz: f64) -> i32 {
    // The small allowance keeps a C typed as 261.63 or 130.81 in its own octave.
    (3 + ((anchor_hz / 261.6255653).log2() + 1e-3).floor() as i32).clamp(-2, 8)
}

/// Where a take's steps go on Live's 128 notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    /// The step on MIDI note 0.
    pub lowest: i64,
    /// Notes whose step falls outside the 128 keys.
    pub outside: usize,
}

/// Choose `lowest` for a take whose notes sit on `steps`: the 1/1 on MIDI note
/// 60 when the whole take fits that way, else the range centred on the take.
pub fn choose_range(steps: &[i64], t: &Steps) -> Range {
    let (Some(&lo), Some(&hi)) = (steps.iter().min(), steps.iter().max()) else {
        return Range {
            lowest: -60,
            outside: 0,
        };
    };
    let n = t.n();
    let mut floor =
        ((1200.0 * (LOWEST_HZ / t.anchor_hz).log2()) / t.period * n as f64).ceil() as i64 - n;
    while t.midi(floor) < hz_to_midi(LOWEST_HZ) - 1e-9 {
        floor += 1;
    }
    let fits = |l: i64| l >= floor && l <= lo && l + MIDI_KEYS - 1 >= hi;
    if fits(-60) {
        return Range {
            lowest: -60,
            outside: 0,
        };
    }
    if hi - lo <= MIDI_KEYS - 1 {
        let centred = lo - (MIDI_KEYS - 1 - (hi - lo)).div_euclid(2);
        let lowest = lo.min(centred.max(floor).max(hi - (MIDI_KEYS - 1)));
        return Range { lowest, outside: 0 };
    }
    let mut sorted = steps.to_vec();
    sorted.sort_unstable();
    let mid = sorted[sorted.len() / 2];
    let lowest = floor.max(mid - MIDI_KEYS / 2);
    Range {
        lowest,
        outside: steps
            .iter()
            .filter(|&&s| s < lowest || s > lowest + MIDI_KEYS - 1)
            .count(),
    }
}

/// A file-name-safe version of a tuning name: "53-edo", "my-scale" for
/// "/some/dir/my scale.scl". Same as `tuningStem` in live-export.ts, but
/// without the folders.
pub fn tuning_stem(name: Option<&str>) -> String {
    let base = name
        .unwrap_or("tuning")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let lower = base.to_ascii_lowercase();
    let base = if lower.ends_with(".scl") || lower.ends_with(".ascl") {
        &base[..base.rfind('.').unwrap_or(base.len())]
    } else {
        base
    };
    let mut out = String::new();
    let mut dash = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || "._-".contains(c) {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    if out.is_empty() {
        "tuning".into()
    } else {
        out
    }
}

/// The clip in tuning steps, and the tuning to load: notes on `step - lowest`,
/// curves bent from the tuned step. Notes beyond Live's 128 keys are left out.
pub fn tuned_clip(
    analysis: &Analysis,
    name: &str,
    duration_s: f32,
    s: &Settings,
) -> Result<(Clip, TuningSystem, Range)> {
    let scl = s
        .tuning_scl
        .as_deref()
        .ok_or_else(|| anyhow!("a tuned set needs a tuning other than 12-TET"))?;
    let scale = Scale::parse(scl).map_err(|e| anyhow!("tuning: {e}"))?;
    let steps = Steps::new(&scale, s.anchor_hz);
    let snapped: Vec<i64> = analysis
        .notes
        .iter()
        .map(|n| steps.snap(n.pitch_center))
        .collect();
    let range = choose_range(&snapped, &steps);
    let mut c = clip(analysis, name, duration_s);
    let mut notes = Vec::with_capacity(c.notes.len());
    for ((note, n), step) in c.notes.drain(..).zip(&analysis.notes).zip(&snapped) {
        let key = step - range.lowest;
        if !(0..MIDI_KEYS).contains(&key) {
            continue;
        }
        let d = (n.pitch as f64 - steps.midi(*step)) as f32;
        let pitch_curve = if note.pitch_curve.is_empty() {
            vec![(0.0, d)]
        } else {
            note.pitch_curve.iter().map(|&(t, b)| (t, b + d)).collect()
        };
        notes.push(Note {
            pitch: key as u8,
            pitch_curve,
            ..note
        });
    }
    c.notes = notes;
    let tuning = TuningSystem::from_scala(
        &tuning_stem(s.tuning_name.as_deref()),
        scl,
        Anchor {
            octave: anchor_octave(s.anchor_hz),
            hz: s.anchor_hz,
            lowest_step: range.lowest,
        },
    )
    .map_err(|e| anyhow!("tuning: {e}"))?;
    Ok((c, tuning, range))
}

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
/// slot and on the Arrangement at beat 0. With a tuning other than 12-TET the
/// set carries the tuning and the notes are its steps (see the module docs).
pub fn als_bytes(analysis: &Analysis, name: &str, duration_s: f32, s: &Settings) -> Result<Vec<u8>> {
    let (c, tuning) = if s.tuning_scl.is_some() {
        let (c, t, _) = tuned_clip(analysis, name, duration_s, s)?;
        (c, Some(t))
    } else {
        (clip(analysis, name, duration_s), None)
    };
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
    write_tuned(&set, TEMPLATE, tuning.as_ref()).map_err(|e| anyhow!("writing .als: {e}"))
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
        let b = als_bytes(&analysis(), "take", 4.0, &Settings::default()).unwrap();
        assert_eq!(&b[..2], &[0x1f, 0x8b]);
    }

    fn gunzip(b: &[u8]) -> String {
        use std::io::Read;
        let mut s = String::new();
        flate2::read::GzDecoder::new(b)
            .read_to_string(&mut s)
            .unwrap();
        s
    }

    fn preset(id: &str) -> Settings {
        Settings {
            tuning_name: Some(id.into()),
            tuning_scl: Some(
                crate::tunings::presets()
                    .into_iter()
                    .find(|t| t.id == id)
                    .unwrap()
                    .scl,
            ),
            ..Settings::default()
        }
    }

    fn steps53() -> Steps {
        let s = preset("53-edo");
        Steps::new(&Scale::parse(s.tuning_scl.as_deref().unwrap()).unwrap(), s.anchor_hz)
    }

    /// 12-TET: the set is exactly what the writer made before tunings existed.
    #[test]
    fn twelve_tet_set_is_unchanged() {
        let a = analysis();
        let c = clip(&a, "take", 4.0);
        let set = Set {
            tempo: BPM,
            tempo_changes: vec![],
            scenes: vec![Scene {
                name: "take".into(),
                tempo: BPM,
            }],
            tracks: vec![Track {
                template: template_tracks(TEMPLATE)[0],
                name: "take".into(),
                session: vec![Some(c.clone())],
                arrangement: Some(c),
            }],
        };
        let plain = expressive_liveset::write(&set, TEMPLATE).unwrap();
        assert_eq!(als_bytes(&a, "take", 4.0, &Settings::default()).unwrap(), plain);
        assert!(gunzip(&plain).contains("<TuningSystems />"));
    }

    /// Same numbers as studio-ui/src/live-export.test.ts.
    #[test]
    fn steps_and_ranges_match_the_studio() {
        let t = steps53();
        assert!((t.midi(0) - 60.0).abs() < 1e-6);
        assert!((t.midi(53) - 72.0).abs() < 1e-6);
        assert!((t.midi(-53) - 48.0).abs() < 1e-6);
        assert_eq!(t.snap(62.0), 9);
        assert_eq!(t.snap(59.9), 0);
        assert_eq!(t.snap(71.95), 53);
        assert_eq!(t.snap(47.5), -2 * 53 + 51);
        assert_eq!(
            choose_range(&[-20, 0, 40], &t),
            Range {
                lowest: -60,
                outside: 0
            }
        );
        let r = choose_range(&[60, 100], &t);
        assert_eq!(r, Range { lowest: 60 - (127 - 40) / 2, outside: 0 });
        let r = choose_range(&[-100, 0, 1, 2, 100], &t);
        assert_eq!(r, Range { lowest: 1 - 64, outside: 2 });
        let ji = Steps::new(
            &Scale::parse(preset("just-12").tuning_scl.as_deref().unwrap()).unwrap(),
            crate::settings::MIDDLE_C_HZ,
        );
        let r = choose_range(&[0, 7], &ji);
        assert!(ji.midi(r.lowest) >= -1e-6);
        assert!(ji.midi(r.lowest - 1) < 0.0);
        assert_eq!(anchor_octave(261.625565), 3);
        assert_eq!(anchor_octave(440.0), 3);
        assert_eq!(anchor_octave(130.8128), 2);
        assert_eq!(anchor_octave(523.2511), 4);
        assert_eq!(tuning_stem(Some("my scale.scl")), "my-scale");
        assert_eq!(tuning_stem(Some("/a b/x/53-edo")), "53-edo");
        assert_eq!(tuning_stem(None), "tuning");
    }

    /// 53-EDO: the note goes on its step (60.2, 20 cents above the 1/1, snaps
    /// to step 1: MIDI note 61 with the 1/1 on 60) and the curve keeps only the
    /// move off that step, so step + curve sounds what 12-TET key + bend did.
    #[test]
    fn a_tuned_clip_holds_steps_and_glides() {
        let a = analysis();
        let s = preset("53-edo");
        let (c, t, r) = tuned_clip(&a, "take", 4.0, &s).unwrap();
        assert_eq!(r.lowest, -60);
        assert_eq!(c.notes.len(), 1);
        let n = &c.notes[0];
        assert_eq!(n.pitch, 61);
        let steps = steps53();
        let step = n.pitch as i64 + r.lowest;
        for ((_, tuned), (_, plain)) in n.pitch_curve.iter().zip(&clip(&a, "take", 4.0).notes[0].pitch_curve) {
            let sounds = steps.midi(step) + *tuned as f64;
            assert!((sounds - (60.0 + *plain as f64)).abs() < 1e-4);
        }
        assert_eq!(t.name, "53-edo");
        assert_eq!(t.notes.len(), 53);
        // Step -60 = 2 periods down (-106) plus 46.
        assert_eq!(t.lowest, expressive_liveset::NotePosition { octave: 1, index: 46 });
    }

    #[test]
    fn a_tuned_set_carries_the_tuning() {
        let xml = gunzip(&als_bytes(&analysis(), "take", 4.0, &preset("53-edo")).unwrap());
        assert!(!xml.contains("<TuningSystems />"));
        assert_eq!(xml.matches("<TuningSystem Id=\"0\">").count(), 1);
        assert!(xml.contains("<TuningSystemName Value=\"53-edo\" />"));
        assert!(xml.contains("<ReferencePitch><Octave Value=\"3\" /><NoteIndexWithinOctave Value=\"0\" /><FrequencyInHz Value=\"261.625565\" /></ReferencePitch>"));
        assert!(xml.contains("<MinOctave Value=\"1\" /><MinNoteIndexWithinOctave Value=\"46\" />"));
        assert!(xml.contains("<MidiKey Value=\"61\" />"));
    }

    /// Notes past Live's 128 keys in the tuning are left out of the clip.
    #[test]
    fn notes_beyond_the_keys_are_left_out() {
        let mut a = analysis();
        let mut far = a.notes[0].clone();
        far.pitch = 127;
        far.pitch_center = 127.0;
        let mut low = a.notes[0].clone();
        low.pitch = 20;
        low.pitch_center = 20.0;
        a.notes.push(far);
        a.notes.push(low);
        // 107 semitones = ~473 steps of 53-EDO: more than 128.
        let (c, _, r) = tuned_clip(&a, "take", 4.0, &preset("53-edo")).unwrap();
        assert!(r.outside > 0);
        assert_eq!(c.notes.len(), a.notes.len() - r.outside);
    }
}
