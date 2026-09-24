# voxmpe-core

The engine for turning a monophonic voice into expressive MPE MIDI. Offline,
pure Rust, numerically testable ("correct" here is a *number*, not a taste).

Used by the **`voxmpe`** app. Everything tuning-agnostic lives here; note *selection*
deliberately does not (see The Seam).

## Modules

| Module | What |
|---|---|
| `interval` | cents ↔ ratio ↔ frequency math |
| `mpe` | `freq → (MIDI note, 14-bit bend)` split + `bend_from_offset` encoder |
| `pitch` | CREPE pitch tracking (`tract-onnx`, offline) |
| `features` | per-frame RMS + spectral centroid |
| `segment` | note segmentation from the pitch contour (vibrato vs note) |
| `expression` | per-note bend/amplitude curves + velocity |
| `smf` | MPE Standard MIDI File serializer (`write_smf`, `smf_bytes`, RPN ±48 setup) |
| `config` / `types` / `resample` | parameters, data types, resampling |

`analyze(audio, sample_rate, &CrepeModel, &AnalysisConfig) -> Analysis` runs the whole
pipeline. It is `track()` (the slow CREPE stage, once per take) followed by
`transcribe()` (segmentation and expression, milliseconds), so a UI can re-segment
with new settings without re-running CREPE.

## The Seam

Turning a fractional pitch into a concrete MIDI note is where consumers diverge, so it is
**not** in the engine. `segment::span_pitch` returns the raw **fractional** center
(f64 semitones) and `Note::pitch_center` carries it verbatim. Downstream:

- a 12-TET consumer reads `Note::pitch` (= `segment::round_to_12tet(pitch_center)`);
- `voxmpe` reads `pitch_center` and quantizes it to a Scala scale degree.

The fraction is never discarded.

## Build & test

```
cargo test --release
```

Zero-network once deps are cached. The 85 MB CREPE model is `models/crepe-full.onnx`
at the repo root (see `models/README.md`); it is gitignored, and tests that need it
skip when it is missing. `CrepeModel::from_path` takes the model path.
