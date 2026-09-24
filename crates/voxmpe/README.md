# voxmpe (app)

The voxmpe app: a local studio UI and a CLI on top of `voxmpe-core`. See the
[repo README](../../README.md) for setup.

- `voxmpe studio`: record or open a take, tune the note splits by ear, save or drag the
  MPE `.mid` into Ableton Live.
- `voxmpe convert <in.wav> -o <out.mid> [flags]`: the same settings from the command line;
  the studio's "Copy as flags" gives the exact flags.

Omit `--tuning` for plain 12-TET; pass a Scala `.scl` (and `--anchor-hz`, the frequency of
the scale's 1/1) for any other tuning. Ableton Live 12's Tuning System is a good oracle for
checking the pitches.

## Modules

| Module | What |
|---|---|
| `scala` | Scala `.scl` parser + mode/equal-division classifier |
| `quantize` | snap a fractional pitch to the nearest scale degree (`Tuning`) |
| `retune` | retune an analysis to a scale, preserving expressive bend |
| `chord` | microtonal chord generation (mode→ordinal, edo→ratio-snap); not used by the studio yet |
| `settings`, `cli` | the settings shared by the studio and the CLI, and their flags |
| `audio`, `model`, `session` | WAV decoding, CREPE model lookup, one loaded take |
| `server` | the studio's local HTTP server |

Design rationale and reference numbers for the tuning code: [`MICROTONAL_SPEC.md`](MICROTONAL_SPEC.md)
(written before the rename, when the app was called microtonal-voxmidi).

## Test

```
cargo test --release -p voxmpe
```
