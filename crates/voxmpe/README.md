# microtonal-voxmidi

Offline, monophonic **singing voice → microtonal expressive MPE MIDI**. Track a vocal
phrase, quantize it to *any* tuning (Scala `.scl`), and emit MPE MIDI that preserves the
voice's vibrato/scoops/dynamics as continuous per-note expression.

The unified successor to `singmidi` (retired): plain 12-TET singing→MIDI is just this tool
with no `--tuning`. Built on the shared **[voxmidi-core](../voxmidi-core)** engine.

> Sibling-clone layout: this crate has a **path dependency** on `../voxmidi-core`, so clone
> both next to each other. (Swap to a git dependency if you want standalone builds.)

## Use

```
microtonal-voxmidi input.wav -o out.mid                 # 12-TET (default)
microtonal-voxmidi input.wav -o out.mid --tuning ji.scl # any Scala tuning
```

Key flags: `--tuning <file.scl>`, `--anchor-hz <Hz>` (frequency of the scale's 1/1; keep
fixed across comparisons), `--model <crepe-full.onnx>`, `--single-channel <range>` (non-MPE),
`--hold-time-ms <ms>` (segmentation). Import the `.mid` into Ableton Live 12, whose native
Tuning System is the ground-truth oracle for verifying the pitches.

## What's here (the microtonal wedge)

| Module | What |
|---|---|
| `scala` | Scala `.scl` parser + mode/equal-division classifier |
| `quantize` | snap a fractional pitch to the nearest scale degree (`Tuning`) |
| `retune` | retune an analysis to a scale, preserving expressive bend |
| `chord` | microtonal chord generation (mode→ordinal, edo→ratio-snap) |

Pipeline: `voxmpe_core::analyze` → `retune(&analysis, &Tuning::new(scale, anchor))` →
`voxmpe_core::smf::write_smf`. Design rationale and reference numbers in
[`MICROTONAL_SPEC.md`](MICROTONAL_SPEC.md).

## Test

```
cargo test
```
