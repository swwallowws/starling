# Starling

A sung phrase in, expressive MPE MIDI out, in any tuning. The code, crates and commands keep the old
name voxmpe. The README explains it; this file is for working on it.

## Working here

1. Do what was asked, the simplest way that meets it. Side work is a proposal that says what it costs.
2. Run the checks below for every path you changed. Report the numbers.
3. A commit's subject names what changed and the trap if there was one. Its body says why, what ran
   and what wasn't tested.
4. When something breaks and nobody saw it, add a rule here in the same commit as the fix.
5. Anything that records from the microphone is the user's to run: give them the command.

## Map

- `crates/voxmpe-core`: the engine (pitch tracking, segmentation in `segment.rs`, defaults in
  `config.rs`, the MPE MIDI writer)
- `crates/voxmpe`: the app (studio, CLI in `cli.rs`, Scala tunings)
- `crates/voxmpe-web`: the engine for the browser studio's workers
- `studio-ui`: the studio's UI, for both the local and the browser studio
- `models/`: how to export the CREPE model (weights are never committed)
- `takes/`: the user's recordings, never committed

## Rules

**Defaults change only with the user.** The segmentation defaults live in `config.rs`. The
settings the user liked on their own singing (2026-09-24) are `--hold-ms 95 --jump-hold-ms 175
--jump-cents 260 --gap-ms 285 --split-cents 90 --onset-delta 1.45`, the ones
`the_exported_midi_has_exactly_the_notes_the_studio_shows` in `crates/voxmpe/tests/session.rs`
uses. A new default or a named preset starts from those and is asked about first. Check: manual.

**The `.als` writer is a pinned git dependency.** `expressive-liveset` comes over HTTPS at a fixed
`rev` in `crates/voxmpe/Cargo.toml`. A fix there reaches Starling only with a new `rev`.
Check: `cargo test --release`.

## Checks

| Changed | Run |
|---|---|
| `crates/**` | `cargo test --release` (tests that need the CREPE model skip without it) |
| `studio-ui/**` | `npm --prefix studio-ui test`; for the browser studio, `npm --prefix studio-ui run e2e:web` |
