# voxmidi-core

The shared engine for turning a monophonic voice into expressive MPE MIDI. Offline,
pure-Rust, numerically testable ("correct" here is a *number*, not a taste).

Consumed by the **`microtonal-voxmidi`** app (and formerly `singmidi`, now retired and
folded in). Everything tuning-agnostic lives here; note *selection* deliberately does not
(see The Seam).

## Modules

| Module | What |
|---|---|
| `interval` | cents ↔ ratio ↔ frequency math |
| `mpe` | `freq → (MIDI note, 14-bit bend)` split + `bend_from_offset` encoder |
| `pitch` | CREPE pitch tracking (`tract-onnx`, offline) |
| `features` | per-frame RMS + spectral centroid |
| `segment` | note segmentation from the pitch contour (vibrato vs note) |
| `expression` | per-note bend/amplitude curves + velocity |
| `smf` | MPE Standard MIDI File serializer (`write_smf`, RPN ±48 setup) |
| `config` / `types` / `resample` | parameters, data types, resampling |

Top-level `analyze(audio, sample_rate, &CrepeModel, &AnalysisConfig) -> Analysis` runs
the whole pipeline.

## The Seam

Turning a fractional pitch into a concrete MIDI note is where consumers diverge, so it is
**not** in the engine. `segment::span_pitch` returns the raw **fractional** center
(f64 semitones) and `Note::pitch_center` carries it verbatim. Downstream:

- a 12-TET consumer reads `Note::pitch` (= `segment::round_to_12tet(pitch_center)`);
- `microtonal-voxmidi` reads `pitch_center` and quantizes it to a Scala scale degree.

The fraction is never discarded.

## Build & test

```
cargo test
```

Zero-network once deps are cached. The 85 MB CREPE model (`models/crepe-full.onnx`) is
**gitignored** — regenerate it with singmidi's `export_crepe.py`; `pitch` takes the model
path as an argument.
