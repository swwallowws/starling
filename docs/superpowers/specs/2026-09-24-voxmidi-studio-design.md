# voxmidi studio: design

Date: 2026-09-24. Status: draft for review.

## Why

Singing into voxmidi works, but the default segmentation splits a lyric-heavy take into too many notes (38 on the first real take). No single setting fixes it: the notes being split are 100 to 200 cent moves lasting 100 to 200 ms, the same shape as real melody notes, so where to split is a judgment made by ear. The fix is a UI where you move the segmentation settings, hear and see the result immediately, and drag the finished MPE `.mid` into Ableton.

The UI is part of the product, not a personal tool. microtonal-voxmidi becomes UI-first: the studio is the main way to use it, and a thin CLI remains for batch work.

## Decisions (from the brainstorm)

- **Form:** a local web app now (Rust server + browser UI), structured so it can be wrapped as a Tauri desktop app later without rewriting.
- **Not a Live extension (for now):** the Ableton Extensions SDK writes clip notes without per-note expression, so bends would be lost (tabridge's extension hits the same limit). Revisit if the SDK gains note expressions.
- **Output stays MPE `.mid`:** confirmed that Live imports its bends as note expressions. No `.als` writer needed.
- **One repo, two crates:** merge voxmidi-core and microtonal-voxmidi into a `voxmidi` workspace. The library is still published to crates.io on its own.
- **v1 microtonal scope:** tuning (Scala `.scl` or 12-TET) and anchor. Chords are future work.
- **CLI:** kept, thin, sharing all logic with the studio.
- **Naming:** the app keeps the name `microtonal-voxmidi` for now. Revisit before publishing, since 12-TET is its default.

## Repo layout

```
voxmidi/
├── Cargo.toml                   workspace
├── crates/voxmidi-core/         library (crates.io). No UI, server, or tuning code.
├── crates/microtonal-voxmidi/   app: thin CLI + `studio` subcommand
├── studio-ui/                   TypeScript + Vite frontend, embedded into the app binary
├── models/                      CREPE model (gitignored) + README on how to get it
├── scripts/export_crepe.py
└── takes/                       local recordings (gitignored)
```

Migration: rename the GitHub repo `swwallowws/voxmidi-core` to `voxmidi` (GitHub redirects the old URL), move the crate into `crates/voxmidi-core/`, and merge microtonal-voxmidi's history in (`git merge --allow-unrelated-histories` after moving its files into `crates/microtonal-voxmidi/`), keeping both commit histories. Archive `swwallowws/microtonal-voxmidi` with a README pointer. Repos stay private until the publish step. The sibling path dependency becomes a workspace dependency.

## voxmidi-core: split analysis in two

`analyze()` stays and gives identical output, but becomes two public steps:

- `track(audio, sample_rate, model, cfg) -> Frames`: CREPE pitch, features, voicing gate. The slow part (about 0.75 s per second of audio on an M1 Max, plus about 2 s to load the model).
- `transcribe(frames, cfg) -> Analysis`: segmentation and expression. Milliseconds.

`Frames` carries the frame list and hop size. Segmentation causes (`segment::Cause`) stay available so the UI can color notes by what started them.

## microtonal-voxmidi app

### session module (no HTTP)

Plain Rust functions a Tauri app could later call directly:

- `Session::load(wav_path | wav_bytes)`: decode to mono, run `track` once, cache the frames and audio.
- `session.render(settings) -> Rendered`: `transcribe` with the segmentation settings, then `retune` to the chosen tuning and anchor. Returns notes (pitch, start, end, velocity, bend and amplitude curves, cause) plus the equivalent CLI flags string.
- `session.export_mid(settings, mode) -> bytes`: the same render, serialized with `write_smf`.

`Settings` holds: hold ms, jump hold ms, jump cents, gap ms, split cents, onset delta (or off), tuning (12-TET or `.scl` text), anchor Hz, output mode (MPE or single channel).

### HTTP layer

`tiny_http`, synchronous, bound to `127.0.0.1`. Serves the embedded UI and these JSON endpoints:

- `GET /takes`: WAV files in `takes/`.
- `POST /load`: open a take by name or upload WAV bytes. Responds when analysis is done.
- `POST /render`: settings in, rendered notes out.
- `GET /audio`: the loaded take's audio, for playback.
- `POST /export`: settings in; writes `takes/<take>_studio.mid` and returns its path, and serves the bytes for drag-out.
- `POST /reveal`: open Finder on the exported file.

### CLI

- `microtonal-voxmidi studio [take.wav]`: starts the server and opens the browser.
- `microtonal-voxmidi convert <in.wav> -o <out.mid> [flags]`: the thin CLI. Uses the same flags the studio shows under "copy as flags".

## studio-ui

Stack: TypeScript + Vite, vanilla DOM, tokens from `tabridge/shared/tokens.css`. One screen:

- **Top bar:** take picker (`takes/` plus "open WAV"), tuning picker (12-TET or load `.scl`) with anchor field, note count.
- **Piano roll:** time across, pitch up. Faint raw pitch contour of what was sung, note bars colored by cause (gap, pitch change, re-attack) with each bend curve drawn inside, and a loudness lane below. Click to seek.
- **Controls:** sliders for hold, jump hold, gap, split cents, onset (with an off switch), a "Legato" preset, "Reset", and the equivalent CLI flags with a copy button. Moving a slider re-renders live, throttled to about 30 per second.
- **Listening:** Space plays and stops. Voice / MIDI / Both switch. The MIDI preview is a small WebAudio synth, one oscillator per note, with frequency following the bend curve and gain following the amplitude curve, so you hear glides and vibrato as the `.mid` encodes them. Changing settings while playing reschedules from the playhead.
- **Export:** "Save .mid" with the saved path and "Reveal in Finder". A drag handle for dragging into Live (Chrome and Edge, through `DownloadURL`). In Safari, save and drag from Finder. The Tauri version makes drag-out work everywhere.

Not in v1: mic recording in the UI (stays in the `record_to_midi` example), loop regions, editing notes by hand, undo, chords.

## Error handling

- Missing CREPE model: a clear message with the download instructions.
- Unreadable or unsupported WAV: an error shown in the UI; the server keeps running.
- Render requested before analysis finishes: ignored, with a progress message shown.
- Port in use: try the next port and print the URL actually used.
- Invalid `.scl`: the parse error shows next to the tuning picker, and the last good tuning stays active.

## Testing

- **Core:** `analyze()` output equals `track()` followed by `transcribe()` on the same input; the existing 18 tests keep passing.
- **Session:** synthetic WAVs through load, render with different settings (note counts change as expected), and export (valid MPE file, checked the same way as `tests/smf_header.rs`).
- **HTTP:** request and response tests against a server on a random port.
- **UI:** `tsc` type-checking, plus unit tests for mapping notes to WebAudio automation and for the piano roll's coordinate math.
- **By ear (the user's checkpoint):** listening quality, choosing the defaults, and dragging into Live, with exact steps provided.

## Future work

- Chords: generate microtonal chords from each sung note with the existing `chord` module.
- Tauri desktop app with native drag-out.
- Mic recording in the studio.
- Ableton Live extension, if the SDK gains per-note expression.
- New segmentation defaults (or a named preset) chosen with the studio, applied to the library before publishing.

## Effect on the Game Plan

Steps 3 (voxmidi-core) and 4 (microtonal-voxmidi) become one project in one repo. Publishing still produces a crates.io library plus the app.
