# voxmpe

Sing, get expressive MPE MIDI. voxmpe tracks a sung phrase with CREPE, splits it into notes, and writes MIDI that keeps the voice's glides, vibrato and dynamics as per-note expression. Optionally snap it to any Scala tuning.

## Studio

    voxmpe studio

Opens a local page where you record (or open) a take, move the note-split settings while listening, and save or drag the `.mid` into Ableton Live. Recordings and exports go to `takes/`.

## CLI

    voxmpe convert take.wav -o take.mid --legato --hold-ms 150

The studio's "Copy as flags" gives the exact flags for the settings you chose.

## Setup

1. Get the CREPE model: see `models/README.md`.
2. Build the UI once: `cd studio-ui && npm install && npm run build`.
3. `cargo install --path crates/voxmpe` (or `cargo run --release -p voxmpe -- studio`).

## Layout

- `crates/voxmpe-core`: the engine library (pitch tracking, segmentation, MPE MIDI writer).
- `crates/voxmpe`: the app (studio, CLI, Scala tuning).
- `studio-ui`: the studio's browser UI.
