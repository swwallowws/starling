# voxmpe studio: design

Date: 2026-09-24. Status: draft for review.

## Why

Singing into the engine works, but the default segmentation splits a lyric-heavy take into too many notes (38 on the first real take). No single setting fixes it: the notes being split are 100 to 200 cent moves lasting 100 to 200 ms, the same shape as real melody notes, so where to split is a judgment made by ear. The fix is a UI where you record or open a take, move the segmentation settings, hear and see the result immediately, and drag the finished MPE `.mid` into Ableton.

The UI is part of the product. The app becomes UI-first: the studio is the main way to use it, and a thin CLI remains for batch work.

## Decisions (from the brainstorm)

- **Name: voxmpe.** Voice in, MPE out: the output that keeps the voice's glides, vibrato, and dynamics as per-note expression is what sets it apart. The repo and app are `voxmpe`, and the library is `voxmpe-core` (both free on crates.io, checked 2026-09-24). This replaces the names voxmidi-core and microtonal-voxmidi.
- **Form:** a local web app (Rust server + browser UI). The session logic is kept separate from HTTP so the core flow stays testable; no desktop app is planned.
- **Not a Live extension (for now):** the Ableton Extensions SDK writes clip notes without per-note expression, so bends would be lost (tabridge's extension hits the same limit). Revisit if the SDK gains note expressions.
- **Output stays MPE `.mid`:** confirmed that Live imports its bends as note expressions. No `.als` writer needed.
- **One repo, two crates:** merge voxmidi-core and microtonal-voxmidi into one `voxmpe` workspace. The library is still published to crates.io on its own.
- **v1 scope:** recording from the mic in the UI, opening existing takes, segmentation settings, tuning (Scala `.scl` or 12-TET) and anchor, listening, export. Chords are future work.
- **CLI:** kept, thin, sharing all logic with the studio.

## Repo layout

```
voxmpe/
├── Cargo.toml                workspace
├── crates/voxmpe-core/       library (crates.io). No UI, server, or tuning code.
├── crates/voxmpe/            app: thin CLI + `studio` subcommand, tuning (scala, quantize, retune, chord)
├── studio-ui/                TypeScript + Vite frontend, embedded into the app binary
├── models/                   CREPE model (gitignored) + README on how to get it
├── scripts/export_crepe.py
└── takes/                    recordings and exports (gitignored)
```

Migration:
- Rename the GitHub repo `swwallowws/voxmidi-core` to `voxmpe` (GitHub redirects the old URL) and the local folder to `~/Playground/voxmpe`.
- Move the library into `crates/voxmpe-core/` and rename the crate (`voxmidi_core` becomes `voxmpe_core` in code).
- Merge microtonal-voxmidi's history in (`git merge --allow-unrelated-histories` after moving its files into `crates/voxmpe/`), keeping both commit histories, and rename that crate and binary to `voxmpe`.
- Archive `swwallowws/microtonal-voxmidi` with a README pointer to voxmpe.
- Repos stay private until the publish step. The sibling path dependency becomes a workspace dependency.

## voxmpe-core: split analysis in two

`analyze()` stays and gives identical output, but becomes two public steps:

- `track(audio, sample_rate, model, cfg) -> Frames`: CREPE pitch, features, voicing gate. The slow part (about 0.75 s per second of audio on an M1 Max, plus about 2 s to load the model).
- `transcribe(frames, cfg) -> Analysis`: segmentation and expression. Milliseconds.

`Frames` carries the frame list and hop size. Segmentation causes (`segment::Cause`) stay available so the UI can color notes by what started them.

## voxmpe app

### session module (no HTTP)

Plain Rust functions, testable without a server:

- `Session::load(wav_path | wav_bytes)`: decode to mono, run `track` once, cache the frames and audio.
- `session.render(settings) -> Rendered`: `transcribe` with the segmentation settings, then `retune` to the chosen tuning and anchor. Returns notes (pitch, start, end, velocity, bend and amplitude curves, cause) plus the equivalent CLI flags string.
- `session.export_mid(settings) -> bytes`: the same render, serialized with `write_smf`.

`Settings` holds: hold ms, jump hold ms, jump cents, gap ms, split cents, onset delta (or off), tuning (12-TET or `.scl` text), anchor Hz, output mode (MPE or single channel).

### HTTP layer

`tiny_http`, synchronous, bound to `127.0.0.1`. Serves the embedded UI and these JSON endpoints:

- `GET /takes`: WAV files in `takes/`.
- `POST /load`: open a take by name, or upload WAV bytes with a name (used by recording). Uploaded takes are saved as `takes/<name>.wav` first. Responds when analysis is done.
- `POST /render`: settings in, rendered notes out.
- `GET /audio`: the loaded take's audio, for playback.
- `POST /export`: settings in; writes `takes/<take>_studio.mid` and returns its path, and serves the bytes for drag-out.
- `POST /reveal`: open Finder on the exported file.

### CLI

- `voxmpe studio [take.wav]`: starts the server and opens the browser.
- `voxmpe convert <in.wav> -o <out.mid> [flags]`: the thin CLI. Uses the same flags the studio shows under "copy as flags".

## studio-ui

Stack: TypeScript + Vite, vanilla DOM, tokens from `tabridge/shared/tokens.css`. One screen:

- **Top bar:** Record button, take picker (`takes/` plus "open WAV"), tuning picker (12-TET or load `.scl`) with anchor field, note count.
- **Recording:** Record asks for mic access (the browser allows it on localhost), shows a live level meter and elapsed time, and Stop (or Space) ends the take. The browser captures raw PCM through WebAudio, encodes a WAV, and uploads it to `POST /load` with an auto name (`take-<date>-<n>`, renamable). The take is saved in `takes/`, analyzed, and opened. No native audio library is needed in the app.
- **Piano roll:** time across, pitch up. Faint raw pitch contour of what was sung, note bars colored by cause (gap, pitch change, re-attack) with each bend curve drawn inside, and a loudness lane below. Click to seek.
- **Controls:** sliders for hold, jump hold, gap, split cents, onset (with an off switch), a "Legato" preset, "Reset", and the equivalent CLI flags with a copy button. Moving a slider re-renders live, throttled to about 30 per second.
- **Listening:** Space plays and stops (when not recording). Voice / MIDI / Both switch. The MIDI preview is a small WebAudio synth, one oscillator per note, with frequency following the bend curve and gain following the amplitude curve, so you hear glides and vibrato as the `.mid` encodes them. Changing settings while playing reschedules from the playhead.
- **Export:** "Save .mid" with the saved path and "Reveal in Finder". A drag handle for dragging into Live (Chrome and Edge, through `DownloadURL`). In Safari, save and drag from Finder.

Not in v1: loop regions, editing notes by hand, undo, chords.

## Error handling

- Missing CREPE model: a clear message with the download instructions.
- Mic access denied or no input device: a message explaining how to allow it (browser site settings, and macOS Privacy & Security for the browser), with "open WAV" still available.
- Silent or very quiet recording: a warning after upload, with the take still saved.
- Unreadable or unsupported WAV: an error shown in the UI; the server keeps running.
- Render requested before analysis finishes: ignored, with a progress message shown.
- Port in use: try the next port and print the URL actually used.
- Invalid `.scl`: the parse error shows next to the tuning picker, and the last good tuning stays active.

## Testing

- **Core:** `analyze()` output equals `track()` followed by `transcribe()` on the same input; the existing 18 tests keep passing after the rename.
- **Session:** synthetic WAVs through load, render with different settings (note counts change as expected), and export (valid MPE file, checked the same way as `tests/smf_header.rs`).
- **HTTP:** request and response tests against a server on a random port, including uploading WAV bytes and finding the saved take in `takes/`.
- **UI:** `tsc` type-checking, plus unit tests for the WAV encoder (round-trip through the server's decoder), mapping notes to WebAudio automation, and the piano roll's coordinate math.
- **By ear and by hand (the user's checkpoint):** recording from the mic, listening quality, choosing the defaults, and dragging into Live, with exact steps provided. Anything that uses the microphone is run by the user, not automatically.

## Future work

- Chords: generate microtonal chords from each sung note with the existing `chord` module.
- Ableton Live extension, if the SDK gains per-note expression.
- New segmentation defaults (or a named preset) chosen with the studio, applied to the library before publishing.

## Effect on the Game Plan

Steps 3 (voxmidi-core) and 4 (microtonal-voxmidi) become one project, voxmpe, in one repo. Publishing still produces a crates.io library (`voxmpe-core`) plus the app (`voxmpe`).

## Addendum (2026-09-24, after the first build)

Added at the user's request so a take does not have to be sung perfectly, and to make the microtonal side usable without finding `.scl` files:

- **Expression sliders** (Settings `smoothing` 0..1, `correction` 0..1, `vibrato` 0..1.5; CLI `--smoothing`, `--correction`, `--vibrato`): reshape each note's pitch curve after retuning, before preview and export. Smoothing low-passes the curve; correction removes slow movement (scoops, drift) toward the scale note; vibrato scales the fast movement. A "center the note" switch was considered and dropped: retuning already centers each note on its scale pitch.
- **Built-in tunings** (`GET /api/tunings`; `--tuning <id>`): 53-EDO and Arel-Ezgi-Uzdilek 24 (Turkish makam), 24-EDO, 5-limit just, Pythagorean, quarter-comma meantone, 19-EDO, 31-EDO, Bohlen-Pierce. Loaded `.scl` files still work.
- **Anchor as note names**: C3 to B4 with one-decimal frequencies, plus a custom Hz field.
- **Roll legend** and marks drawn above each note's start, so they are not confused with the pitch line.
- **Fixes from the final review**: one owner for settings, tuning picker state, `GET /api/current` for a take opened from the command line, "Open WAV", Space handling, replay from the start, a sample-rate guard.
