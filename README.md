# Starling

simply sing.

Formerly voxmpe; the code, crates and commands keep that name.

Sing, get expressive MPE MIDI. Starling tracks a sung phrase with CREPE, splits it into notes, and writes MIDI that keeps the voice's glides, vibrato and dynamics as per-note expression. Optionally snap it to any Scala tuning.

## Studio

    voxmpe studio

Opens a local page where you record (or open) a take, move the note-split settings while listening, and save or drag the `.mid` into Ableton Live. Recordings and exports go to `takes/` in the current folder (`--takes DIR` to change it).

## CLI

    voxmpe convert take.wav -o take.mid --legato --hold-ms 150

The studio's "Copy as flags" gives the exact flags for the settings you chose.

## Browser studio

The same studio, running entirely in the browser with CREPE tiny (2 MB): no
install, recordings kept in the browser.

    python scripts/export_crepe.py tiny     # once: models/crepe-tiny.onnx
    cd studio-ui && npm install
    npm run build:web                       # site in studio-ui/web-dist
    npm run preview:web                     # try it at http://localhost:4318
    npm run e2e:web                         # headless Chrome check

`build:web` also needs `wasm-pack` and the `wasm32-unknown-unknown` Rust target
(`rustup target add wasm32-unknown-unknown`).

`scripts/deploy-web.sh --stage DIR` stages the site; `--push CHECKOUT` publishes
it to a clone of `swwallowws/starling-web` (GitHub Pages).

## Setup

Needs Rust, Node, and Python with torch, torchcrepe and onnxruntime (for the model export).

1. Get the CREPE model: see `models/README.md`.
2. Build the UI once: `cd studio-ui && npm install && npm run build`.
3. `cargo install --path crates/voxmpe` (or `cargo run --release -p voxmpe -- studio`).

`voxmpe convert take.wav -o take.als` writes a Live 12 set instead of MIDI.
With a tuning other than 12-TET the set opens with that tuning loaded, the
notes are its steps (the same numbers as the "MIDI + tuning for Live 12"
export) and each note's pitch curve holds only its glides and vibrato.

The `.als` writer comes from
[expressive-liveset](https://github.com/swwallowws/expressive-liveset), a git
dependency fetched over SSH. That repo is private for now, so the build fails
without access to it.

## Tests

    cargo test --release          # Rust; tests that need the CREPE model skip without it
    cd studio-ui && npm test      # UI

## Layout

- `crates/voxmpe-core`: the engine library (pitch tracking, segmentation, MPE MIDI writer).
- `crates/voxmpe`: the app (studio, CLI, Scala tuning).
- `crates/voxmpe-web`: the engine for the browser studio's Web Workers.
- `studio-ui`: the studio's browser UI, for both the local and the browser studio.

No recordings, takes or model weights are in this repo: takes stay in `takes/`
(or in the browser), and the model is exported locally.

## License

MIT, see `LICENSE`.

Third-party material it downloads or ships:

- CREPE pitch model weights (Jong Wook Kim et al., 2018): MIT. Exported locally
  from the [torchcrepe](https://github.com/maxrmorrison/torchcrepe) package
  (Max Morrison, 2020, MIT) by `scripts/export_crepe.py`; not committed.
- Fonts in `studio-ui/vendor/design/fonts`: Archivo and JetBrains Mono, SIL Open
  Font License 1.1 (license texts next to the fonts).
