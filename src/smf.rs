//! MPE MIDI serialization (SPEC §6). Default output is MPE-structured: one note
//! per rotating member channel, per-note pitchbend (±48 st) for the bend curve,
//! and CC11 for amplitude. A single-channel fallback (±2 st) is provided for
//! non-MPE instruments.
//!
//! The 14-bit bend encoding is NOT duplicated here: it is folded onto
//! [`crate::mpe::bend_from_offset`] (singmidi's old local `bend_value` ≡ that
//! function), so the whole workspace shares one semitone-offset -> bend code path.

use anyhow::Result;
use midly::{
    num::{u14, u15, u24, u28, u4, u7},
    Format, Header, MetaMessage, MidiMessage, Smf, Timing, Track, TrackEvent, TrackEventKind,
};

use crate::mpe;
use crate::types::{Analysis, Note};

const TICKS_PER_BEAT: u16 = 480;
const TEMPO_BPM: f32 = 120.0;
const CC_EXPRESSION: u8 = 11;

#[derive(Debug, Clone, Copy)]
pub enum OutputMode {
    /// MPE: master channel 1, member channels 2..=16, per-note bend range ±48.
    Mpe,
    /// Single channel 1, configurable bend range (default ±2).
    SingleChannel { bend_range: u8 },
}

impl OutputMode {
    fn bend_range(&self) -> f32 {
        match self {
            OutputMode::Mpe => 48.0,
            OutputMode::SingleChannel { bend_range } => *bend_range as f32,
        }
    }
}

/// A timed MIDI event prior to delta-time encoding.
struct Ev {
    tick: u32,
    /// ordering tiebreak at equal tick (lower = earlier): bend/cc setup < note-on, note-off < everything
    order: u8,
    channel: u8,
    kind: EvKind,
}

enum EvKind {
    NoteOn {
        key: u8,
        vel: u8,
    },
    NoteOff {
        key: u8,
    },
    /// 14-bit pitch-bend value (0..16383, 8192 = center), as produced by
    /// [`crate::mpe::bend_from_offset`].
    Bend {
        value: u16,
    },
    Cc {
        ctrl: u8,
        value: u8,
    },
    Pressure {
        value: u8,
    },
}

fn seconds_to_ticks(s: f32) -> u32 {
    let beats = s * (TEMPO_BPM / 60.0);
    (beats * TICKS_PER_BEAT as f32).round() as u32
}

/// Assign an MPE member channel per note, rotating 2..=16, so overlapping
/// release tails (legato bends) don't collide on one channel.
fn assign_channels(notes: &[Note], mode: OutputMode) -> Vec<u8> {
    match mode {
        OutputMode::SingleChannel { .. } => vec![0u8; notes.len()],
        OutputMode::Mpe => {
            // member channels are 1..=15 (0-based) i.e. MIDI ch 2..=16
            let members: Vec<u8> = (1..=15).collect();
            let mut next = 0usize;
            notes
                .iter()
                .map(|_| {
                    let ch = members[next % members.len()];
                    next += 1;
                    ch
                })
                .collect()
        }
    }
}

pub fn write_smf(analysis: &Analysis, mode: OutputMode, path: &str) -> Result<()> {
    let mut events: Vec<Ev> = Vec::new();
    let range = mode.bend_range();
    let channels = assign_channels(&analysis.notes, mode);

    for (note, &ch) in analysis.notes.iter().zip(&channels) {
        let on = seconds_to_ticks(note.start);
        let off = seconds_to_ticks(note.end).max(on + 1);
        let vel = ((note.velocity * 126.0).round() as u8 + 1).clamp(1, 127);

        // Bend curve: emit a point per curve sample on the note's channel.
        for p in &note.bend {
            events.push(Ev {
                tick: seconds_to_ticks(p.time).clamp(on, off),
                order: 1,
                channel: ch,
                kind: EvKind::Bend {
                    value: mpe::bend_from_offset(p.value as f64, range as f64),
                },
            });
        }
        // Amplitude -> CC11.
        for p in &note.amplitude {
            events.push(Ev {
                tick: seconds_to_ticks(p.time).clamp(on, off),
                order: 1,
                channel: ch,
                kind: EvKind::Cc {
                    ctrl: CC_EXPRESSION,
                    value: (p.value * 127.0).round().clamp(0.0, 127.0) as u8,
                },
            });
        }
        // Reserved MPE dimensions, emitted only if the encoder populated them.
        for p in &note.pressure {
            events.push(Ev {
                tick: seconds_to_ticks(p.time).clamp(on, off),
                order: 1,
                channel: ch,
                kind: EvKind::Pressure {
                    value: (p.value * 127.0).round().clamp(0.0, 127.0) as u8,
                },
            });
        }
        for p in &note.slide {
            events.push(Ev {
                tick: seconds_to_ticks(p.time).clamp(on, off),
                order: 1,
                channel: ch,
                kind: EvKind::Cc {
                    ctrl: 74,
                    value: (p.value * 127.0).round().clamp(0.0, 127.0) as u8,
                },
            });
        }
        events.push(Ev {
            tick: on,
            order: 2,
            channel: ch,
            kind: EvKind::NoteOn {
                key: note.pitch,
                vel,
            },
        });
        events.push(Ev {
            tick: off,
            order: 0,
            channel: ch,
            kind: EvKind::NoteOff { key: note.pitch },
        });
    }

    // Stable sort by (tick, order) so note-offs precede re-onsets and bend/cc
    // setup lands before the note-on at the same tick.
    events.sort_by(|a, b| a.tick.cmp(&b.tick).then(a.order.cmp(&b.order)));

    let mut track = Track::new();

    // --- header: tempo + RPN pitchbend-range setup ---
    track.push(TrackEvent {
        delta: 0.into(),
        kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(
            (60_000_000.0 / TEMPO_BPM) as u32,
        ))),
    });
    push_bend_range_rpn(&mut track, mode);

    // --- timed events with delta encoding ---
    let mut last_tick = 0u32;
    for ev in &events {
        let delta = ev.tick.saturating_sub(last_tick);
        last_tick = ev.tick;
        let ch = u4::new(ev.channel);
        let message = match &ev.kind {
            EvKind::NoteOn { key, vel } => MidiMessage::NoteOn {
                key: u7::new(*key),
                vel: u7::new(*vel),
            },
            EvKind::NoteOff { key } => MidiMessage::NoteOff {
                key: u7::new(*key),
                vel: u7::new(0),
            },
            EvKind::Bend { value } => MidiMessage::PitchBend {
                bend: midly::PitchBend(u14::new(*value)),
            },
            EvKind::Cc { ctrl, value } => MidiMessage::Controller {
                controller: u7::new(*ctrl),
                value: u7::new(*value),
            },
            EvKind::Pressure { value } => MidiMessage::ChannelAftertouch {
                vel: u7::new(*value),
            },
        };
        track.push(TrackEvent {
            delta: u28::new(delta),
            kind: TrackEventKind::Midi {
                channel: ch,
                message,
            },
        });
    }
    track.push(TrackEvent {
        delta: 0.into(),
        kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
    });

    let smf = Smf {
        header: Header::new(
            Format::SingleTrack,
            Timing::Metrical(u15::new(TICKS_PER_BEAT)),
        ),
        tracks: vec![track],
    };
    smf.save(path)?;
    Ok(())
}

/// RPN 6: MPE Configuration Message. Sent on the master channel, data = number
/// of member channels. Lets MPE synths switch into MPE mode from the file alone.
const RPN_MPE_CONFIG: u8 = 6;
/// RPN 0: pitchbend sensitivity.
const RPN_BEND_RANGE: u8 = 0;
/// MPE lower zone: master channel 1 + member channels 2..=16.
const MPE_MEMBER_CHANNELS: u8 = 15;

/// Tick-0 setup: in MPE mode, the MPE Configuration Message on the master
/// channel first (it resets member bend ranges), then RPN 0 (pitchbend range)
/// on every channel in use.
fn push_bend_range_rpn(track: &mut Track, mode: OutputMode) {
    let semis = mode.bend_range() as u8;
    let channels: Vec<u8> = match mode {
        OutputMode::SingleChannel { .. } => vec![0],
        OutputMode::Mpe => {
            push_rpn(track, 0, RPN_MPE_CONFIG, MPE_MEMBER_CHANNELS);
            (0..=15).collect() // master + all members
        }
    };
    for ch in channels {
        push_rpn(track, ch, RPN_BEND_RANGE, semis);
    }
}

/// Write one RPN (MSB 0, LSB `rpn`) with data-entry MSB `value`, then the RPN
/// null so later stray data-entry CCs can't change it.
fn push_rpn(track: &mut Track, channel: u8, rpn: u8, value: u8) {
    for (ctrl, val) in [
        (101u8, 0u8), // RPN MSB
        (100, rpn),   // RPN LSB
        (6, value),   // data entry MSB
        (38, 0),      // data entry LSB
        (101, 127),   // RPN null
        (100, 127),
    ] {
        track.push(TrackEvent {
            delta: 0.into(),
            kind: TrackEventKind::Midi {
                channel: u4::new(channel),
                message: MidiMessage::Controller {
                    controller: u7::new(ctrl),
                    value: u7::new(val),
                },
            },
        });
    }
}
