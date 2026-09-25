# voxmpe

Sing, get expressive MPE MIDI. voxmpe tracks a sung phrase with CREPE, splits it into notes, and writes MIDI that keeps the voice's glides, vibrato and dynamics as per-note expression. Optionally snap it to any Scala tuning.

## Studio

    voxmpe studio

Opens a local page where you record (or open) a take, move the note-split settings while listening, and save or drag the `.mid` into Ableton Live. Recordings and exports go to `takes/`.

## CLI

    voxmpe convert take.wav -o take.mid --legato --hold-ms 150

The studio's "Copy as flags" gives the exact flags for the settings you chose.

## Browser studio

The same studio, running entirely in the browser with CREPE tiny (2 MB): no
install, recordings kept in the browser.

    python scripts/export_crepe.py tiny     # once: models/crepe-tiny.onnx
    cd studio-ui && npm run build:web       # site in studio-ui/web-dist
    npm run preview:web                     # try it at http://localhost:4318
    npm run e2e:web                         # headless Chrome check

`scripts/deploy-web.sh --stage DIR` stages the site; `--push CHECKOUT` publishes
it to a clone of `swwallowws/voxmpe-web` (GitHub Pages).

## Setup

1. Get the CREPE model: see `models/README.md`.
2. Build the UI once: `cd studio-ui && npm install && npm run build`.
3. `cargo install --path crates/voxmpe` (or `cargo run --release -p voxmpe -- studio`).

## Layout

- `crates/voxmpe-core`: the engine library (pitch tracking, segmentation, MPE MIDI writer).
- `crates/voxmpe`: the app (studio, CLI, Scala tuning).
- `crates/voxmpe-web`: the engine for the browser studio's Web Workers.
- `studio-ui`: the studio's browser UI, for both the local and the browser studio.
