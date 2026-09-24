> Historical design record, written when this app was microtonal-voxmidi and the engine was voxmidi-core. They are now `voxmpe` and `voxmpe-core` in one workspace.

# Microtonal Voice-to-MIDI — Build Handoff

Context and decisions from planning session. Intended as a starting brief for building with Claude Code.

**Consolidation (verified against the actual sibling projects).** The planning note
that this "pairs with an existing Rust/nih-plug melody-to-MIDI SPEC" was wrong on one
word — **nih-plug**. The real sibling was `../singmidi`, an **offline CLI** doing voice
→ expressive MPE MIDI (CREPE tracking, segmentation, pitch-bend + CC11) that **writes a
`.mid` you import into Ableton** — no plugin. Since 12-TET is just one tuning
(`12-tet.scl`), that tool is a *subset* of this one, so the two are being merged:

- **`../voxmidi-core`** (crate `voxmpe_core`) — the shared **engine**: tuning-agnostic
  primitives (`interval`, `mpe`) plus the pitch/segmentation/expression/serializer
  migrated out of singmidi. The 85 MB CREPE model stays gitignored.
- **This project** (`microtonal-voxmidi`) — the ONE **app**: depends on the engine, owns
  the microtonal wedge (Scala tuning, scale quantization, chords) AND absorbs singmidi's
  app layer (WAV I/O, CLI) + expressive continuous bend. Plain singing→MIDI = this app
  with a trivial `12-tet.scl` and no chords.
- **`../singmidi` is retired** — its code salvaged into the two crates above.

- **No plugin wrapper for the MVP.** Offline: process a clip, write `.mid`, import into
  Ableton 12 (whose Tuning System is our oracle).
- **If real-time is ever needed:** `../yousuckatdrums` already has a reusable nih-plug
  VST3/CLAP scaffold (incl. an MIT-relicensed nih-plug fork). Lift that; don't
  hand-roll. Caveat: it does basic channel-0 notes only — no MPE — so real-time
  microtonal MPE is new work regardless. Another reason to stay offline for now.

## What this is

A voice-to-MIDI tool in the spirit of Dubler 2, but scoped narrow around a distinctive wedge: **general microtonal support**. Not competing with Dubler head-on. The value is the microtonal angle plus leveraging the existing MPE melody-to-MIDI work, not matching Dubler's full feature surface.

## Scope decisions

**In scope:**
- Monophonic pitch -> MIDI (the melody path; largely covered by existing SPEC.md).
- Microtonal quantization + output via MPE per-note pitch bend.
- Timbre/envelope -> CC (loudness, vowel/formant, brightness mapped to continuous controllers). Reuses analysis already done for pitch; cheap to add; more valuable in a microtonal frame than 12-TET.
- Chord generation as the *centerpiece research problem* — microtonal chords are novel territory because interval stacks aren't fixed semitone counts across arbitrary tunings.

**Out of scope (deliberately cut):**
- Beatbox/percussion **triggers**. Separate ML build (MFCC + light classifier, delayed-decision classification, AVP dataset). Orthogonal to microtonal, adds surface area without touching what makes this distinctive. Skip for now.

**Microtonal approach:** GENERAL engine (Scala `.scl` file import, any tuning), not a specific-maqam opinionated system. More broadly useful, less work to make "correct," and the general engine is the more reusable primitive.

## Dubler's three subsystems (reference, for understanding the surface)

- **Triggers** — beatbox sounds -> drum hits (up to 8). Separate signal path; cares only what sound + when, not pitch. CUT.
- **Chords** — one sung note expanded to a voicing, quantized to key. KEEP as core research problem. Deeply entangled with microtonal.
- **CC (timbre/envelope)** — voice qualities -> continuous controllers (loudness->cutoff, vowel/formant->param, brightness->send). KEEP; cheap, pairs well with microtonal.

## Target environment

- **Ableton Live 12** (confirmed). Has native **Tuning System** (added Live 12, Dec 2023) that loads Scala files — first-class microtonal in Ableton.
- A default fresh Ableton project is strictly **12-TET**, A4=440, until tuning is deliberately added. This is a MIDI limitation (integer note numbers, no fractional pitch), not an Ableton one.

## Architecture decision: tool owns the tuning

Two possible paths:
1. **Tool owns tuning** — loads `.scl` itself, does all pitch math, outputs MPE with per-note bend. Portable, DAW-agnostic, matches existing MPE design. Duplicates logic Live 12 already has, but that's fine. **← CHOSEN.**
2. Tool owns only quantization (snap to scale degree, plain notes, let Live's Tuning System supply cents). Simpler but locks to Live 12. Rejected.

**Use Live 12's native Tuning System as the ground-truth ORACLE for testing** — load the same `.scl` into Live, compare frequencies against the tool's MPE output. This is a *sameness* test needing no musical judgment.

## The core primitive: freq -> (note, bend)

Everything hinges on the **fractional MIDI note number**. Compute it first, never lose the fraction until the final split.

```
# Scala degree (cents above 1/1 anchor) -> frequency
f = f_ref * 2^(cents / 1200)              # ratios: cents = 1200*log2(ratio)

# frequency -> fractional MIDI note (A4 = 69 = 440 Hz)
n_float = 69 + 12*log2(f / 440)

# split: round to NEAREST (keeps worst-case bend within +/-50 cents)
note   = round(n_float)
offset = n_float - note                    # semitones, (-0.5, +0.5]

# cents offset -> 14-bit bend (8192 = center, spans +/- bend_range semitones)
bend = round(8192 + offset * (8192 / bend_range))
bend = clamp(bend, 0, 16383)
lsb  = bend & 0x7F
msb  = (bend >> 7) & 0x7F
# message: 0xE0|channel, lsb, msb
```

Rust reference:
```rust
fn freq_to_note_and_bend(freq: f64, bend_range: f64) -> (u8, u16) {
    let n_float = 69.0 + 12.0 * (freq / 440.0).log2();
    let note = n_float.round();
    let offset = n_float - note;                       // semitones, (-0.5, 0.5]
    let bend_f = 8192.0 + offset * (8192.0 / bend_range);
    let bend = bend_f.round().clamp(0.0, 16383.0) as u16;
    (note as u8, bend)
}
```

## The three things that will bite (implementation gotchas)

1. **Bend range is a contract, not a constant.** `bend_range` in code must EXACTLY equal the synth's configured range. #1 microtonal MPE bug. MPE convention: +/-48 on member channels, +/-2 on master. Set explicitly on the synth AND hardcode the same value; ideally send RPN 0,0 (pitch-bend sensitivity) at note-on so you don't trust the synth's saved state. Symptom of mismatch: everything sounds nearly-but-not-quite in tune. Smoke alarm: bends hitting 0 or 16383 -> range assumption wrong.

2. **Resolution check.** 14 bits over +/-48 semitones = 9600c / 16384 ≈ **0.59 cents/step** — inaudible, fine. But at a wrong assumed range everything's off by a factor.

3. **One note per channel, or bends collide.** Pitch bend is per-*channel*, not per-note. This is the entire reason MPE exists. Monophonic melody: trivial. Microtonal **chords**: every chord tone may need a *different* bend, so each is an independent (note, bend, channel) triple — no shortcut of bending a whole channel once. Requires a real MPE channel allocator (round-robin across member channels 2–16, master on 1, with voice-stealing) and note-off bookkeeping tracking which channel holds which note. This is the central bookkeeping problem once chords enter.

## Testing strategy (three layers, cheapest first)

Key principle: **don't rely on the ear you don't yet have. "Correct" in microtonal is a number.**

**Layer 1 — test against math, not sound.** Verify `freq_to_note_and_bend` numerically before anything makes noise. Known cases: 440Hz -> note 69, bend 8192. Middle C (12-TET) -> note 60, centered. A +50c target -> asserted bend. Catches the bend-range bug mechanically. (A Rust test suite was drafted covering 12-TET, JI thirds/fifths, the bend-range trap, resolution, clamp, and anchor discipline — reproduce it as `tuning_tests.rs`. NOTE: it was NOT compiled/run in session — no Rust toolchain available — so treat assertions as unverified until `cargo test` passes. The JI reference numbers below are the source of truth to check against.)

**Layer 2 — Live 12 as oracle (sameness test, no musical judgment).** Load `.scl` into Live 12 Tuning System, play a degree through a plain instrument = ground truth. Play same degree through tool's MPE path into same synth. Compare Hz with a tuner/spectrum analyzer plugin on both outputs — should match within a cent.

**Layer 3 — famous, unambiguous tunings so "right" is documented:**
- **Just intonation major** — reference point. Pure (beatless) major third & fifth. Ear test: JI major triad vs 12-TET major triad back-to-back — JI is calmer, 12-TET third audibly *beats* (slow wobble). If JI third beats, something's wrong.
- **Bohlen–Pierce** — no octave, 3:1 "tritave," sounds alien. If it sounds normal, ratios aren't being applied.
- **19-TET / 31-TET** — documented equal divisions; 31-TET famous for near-pure thirds; reference recordings exist.

**"Tuning sanity" regression track:** one MIDI clip, sustained major triad, routed through (a) 12-TET, (b) Live native JI, (c) tool's JI. Loop it. 12-TET beats; both JI versions calm; tool's version indistinguishable from Live's. Doubles as ear-training. Run after every tuning-code change.

## Reference numbers (source of truth for tests)

- Cents: 1200/octave, 100/12-TET semitone. Smallest audible interval ≈ 5 cents.
- **Beating:** two close frequencies wobble at their difference frequency; pure intervals don't wobble. This + cents is the whole minimum ear needed for testing.
- JI major third **5/4 = 386.31 cents** (~14c FLATTER than 12-TET 400c — this flatness is why it doesn't beat).
- JI perfect fifth **3/2 = 701.96 cents** (~2c wider than 700; nearly identical, why fifths barely beat in 12-TET but thirds do).
- JI third above middle C -> note 64 (E) bent ~-13.7 cents.

## Anchor discipline (false-alarm guard)

A `.scl` defines **intervals, not absolute pitches**. It needs a reference frequency tied to a reference MIDI note (the 1/1 anchor) to become concrete. **Decide the anchor explicitly and keep it FIXED across every comparison.** If Live and the tool anchor 1/1 differently, they disagree by a *constant* offset — you'll think the math is broken when it's just a different starting pin. Signature of an anchor mismatch (vs a real math error): the discrepancy is a constant ratio across all degrees, not a per-note variation.

## Architecture: reuse map

One engine (`voxmidi-core`) + one app (this crate). singmidi retired into both.

| Capability | Home | Status |
|---|---|---|
| CREPE pitch tracking (offline) | `voxmidi-core::pitch` (from singmidi) | migrating |
| Note segmentation (vibrato-vs-note) | `voxmidi-core::segment` (from singmidi) | migrating |
| freq→(note,bend), 14-bit encoder | **`voxmidi-core::mpe`** | **built** |
| cents↔ratio↔freq math | **`voxmidi-core::interval`** | **built** |
| MPE serialization (SMF, RPN setup) | `voxmidi-core::smf` (from singmidi cli) | migrating |
| amplitude→CC11, velocity | `voxmidi-core::expression` (from singmidi) | migrating |
| Scala `.scl` + classifier | **`microtonal` `src/scala.rs`** | **built** |
| Chord generation | **`microtonal` `src/chord.rs`** | **built** |
| Scale quantization (frac pitch → degree) | `microtonal` (new) | to build |
| App layer: WAV I/O + CLI | `microtonal` (from singmidi cli) | to migrate |
| Expressive continuous bend (vibrato/scoops) | `microtonal` (from singmidi) | to wire |
| Polyphonic MPE allocator (voice-stealing) | nobody has it | to build |
| Timbre/vowel → CC | nobody has it (centroid computed, unmapped) | to build |
| nih-plug plugin scaffold | `yousuckatdrums` (MIT fork) | reuse *if* real-time |

**The seam:** `voxmidi-core` yields a *fractional* pitch per note; note SELECTION is
the consumer's job — `singmidi` rounds to 12-TET, this project quantizes to a scale
degree (`scala.rs`), then calls `freq_to_note_and_bend`.

## Suggested build order

1. ✅ Layer-1 numerical harness green — `voxmidi-core` (12 tests) + `microtonal` (10 tests).
2. ✅ Core primitive + Scala `.scl` parser — `voxmidi-core::mpe` + `src/scala.rs`.
3. Scale quantization: take `voxmidi-core` segmentation's fractional pitch → nearest
   scale degree → `freq_to_note_and_bend` → MPE `.mid`. Validate against Live 12 oracle.
   (Depends on phase-2 migration of pitch/segment into `voxmidi-core`.)
4. CC/timbre path (map `singmidi`'s already-computed spectral centroid → CC; add vowel/formant).
5. MPE channel allocator (round-robin + voice-stealing + note-off bookkeeping) — the
   one real-time piece nobody has; needed once chords go polyphonic.
6. ✅ Microtonal chord generation — see "Chord semantics" below. Built in `src/chord.rs`,
   tests in `tests/chord.rs`. Each chord tone an independent note/bend/channel triple.

## Chord semantics (the centerpiece — designed)

Microtonal chords were the open design question. This is the resolved model. The
framing that unlocked it: because the freq -> (note, bend) primitive already renders
**any** pitch over MPE, scale-membership of chord tones is a *choice*, not a
technical constraint. The real question is not "what chords does this tuning permit"
but **how tightly chord tones bind to the scale grid.**

### The bifurcation (the crux)

What a chord *means* depends on what kind of `.scl` you loaded. This is not a
preference — it is forced by the numbers (see reference table below):

- **A mode** (~5–9 notes: JI major, a maqam, a raga scale) carries harmony in its
  degree *layout*. Stack scale degrees `i, i+2, i+4` (**ordinal** stacking) and you
  get the right chord, always in-scale, by construction. For the JI major mode this
  yields a 0.0-cent-error major triad.
- **An equal division** (12-TET, 31-TET, Bohlen–Pierce) has no built-in notion of
  "which degrees are chord tones." Ordinal stacking of `i, i+2, i+4` produces a
  **cluster** (a whole-tone smear), not a chord. You must aim at **ratio targets**
  and snap each to the nearest degree.

**v1 routing rule:** classify the `.scl` as *mode* vs *equal division*, then route by
the table below. Classification is **declaration-first, heuristic-fallback**:

1. If the tuning declares its kind, obey it — a `! kind: mode` / `! kind: edo`
   comment in the `.scl`, or a sidecar/config field. This is the escape hatch: a
   hand-authored maqam with 12+ degrees, or a mode that happens to be near-equal,
   would fool any heuristic, so let the author pin it.
2. Otherwise infer: near-uniform step sizes (max/min step ratio < ~1.1) **and**
   cardinality ≥ 12 → equal division; otherwise mode.
3. Log the classification and which path decided it (declared vs inferred), so a
   misroute is visible in output rather than silent — same discipline as the
   anchor/bend-range smoke alarms.

| `.scl` kind | Chord model | Why |
|---|---|---|
| Mode (~5–9 deg) | **Ordinal** — degrees `i, i+2, i+4` (mod period) | Harmony is in the degree spacing; always in-scale, always defined |
| Equal division | **Ratio-snap** — target ratios → nearest degree | Ordinal gives clusters; ratio targets recover consonant chords |

### Ratio sets are tuning-native, not hardcoded

For the ratio-snap path, the target set (the chord "quality") is **keyed by tuning
family**, because 5:4 / 3:2 is only "major" in octave-based tunings:

- Octave-based (12-TET, 31-TET, JI): major = `{5/4, 3/2}`, minor = `{6/5, 3/2}`, etc.
- **Bohlen–Pierce** (3:1 tritave, no octave): major = `{5/3, 7/3}` (the 3:5:7 chord).
  Snapping a 5/4 into BP lands 52.6c off with a **40 Hz beat** — the wrong question,
  not a snap failure.

Unknown/unclassified scales fall back to ordinal stacking (always defined, never
crashes; consonance not guaranteed but reported).

### "No triad here" is a number, not a shrug

Some tunings can't approximate the ratio targets (5-TET, forced octave-ratios in
Bohlen–Pierce). Do **not** emit a harsh forced triad. On the **ratio-snap path**,
after snapping each target to a degree, measure the **snap error in cents** vs the
tuning-native target; if either upper tone lands beyond the guard (**start ~35c**),
**degrade to the best dyad/drone and flag "no stable triad in this tuning."** The
ordinal (mode) path is exempt — a mode's own degrees define its triad, including a
deliberately neutral third; we trust the author, not a 5/4 yardstick.

**Guard is in cents, not Hz — a lesson from building it.** The first cut thresholded
on beat *rate* (Hz) and it wrongly rejected the plain 12-TET major triad: 12-TET's
third beats ~10.4 Hz at middle C, which *looks* like "no triad" but is just the
ordinary tempered third. Beat rate is **register-dependent** (the same interval beats
faster an octave up), so it's a fine ear-training *diagnostic* but a bad guard.
Cents deviation from the target ratio is register-independent and cleanly separates
"tempered but real" (12-TET, ~14c) from "not there" (octave-ratios-in-BP, ~53c;
5/4-in-5-TET, ~94c). Keep beat Hz as a reported number; guard on cents.

### Layered architecture (novelty isolated to layers 2–3)

1. **Root** — sung note → nearest scale degree (existing primitive).
2. **Chord model** — quality = interval targets in ordinal *or* ratio coords (routed above).
3. **Snap policy** — per target: snap / (optional) free-JI / reject, driven by the
   beat-rate metric; **report per-tone cents error**.
4. **Voicing** — register/period placement, spread. Separable; layered on top.
5. **MPE realization** — each final pitch → (note, bend, channel) via the verified
   primitive + channel allocator.

Layers 1, 4, 5 are plumbing already specced. The genuine research novelty lives only
in 2–3.

### Optional later: free-JI toggle

A "purist off the grid" mode that sounds exact ratios above the root, ignoring the
scale grid entirely (0.0 beat, max consonance, but tones may not exist in the
tuning — "JI chords rooted on scale degrees," not "chords in the tuning"). Deferred;
not v1. Sits at the far end of the grid-binding spectrum from strict ordinal.

### Reference numbers (major triad on middle C, source of truth for tests)

Ratio-snap, targets 5/4 (386.31c) and 3/2 (701.96c), 1/1 anchor = middle C:

| Tuning | 3rd (cents) | 3rd err | 3rd beat | 5th (cents) | 5th err | Note |
|---|---|---|---|---|---|---|
| JI major | 386.3 | +0.0c | **0.0 Hz** | 702.0 | +0.0c | pure by construction |
| 31-TET | 387.1 | +0.8c | **0.6 Hz** | 696.8 | −5.2c | near-pure 3rd; weaker 5th |
| 12-TET | 400.0 | +13.7c | **10.4 Hz** | 700.0 | −2.0c | the audible 12-TET 3rd wobble |
| Bohlen–P (5/4 target) | 438.9 | +52.6c | **40.4 Hz** | 731.5 | +29.6c | wrong ratio set → use 3:5:7 |

Ordinal `i, i+2, i+4`: JI major → perfect triad (+0.0c); 12-TET / 31-TET → clusters
(+200c/+400c and +77c/+155c) — demonstrates why equal divisions must use ratio-snap.

(Pinned as Layer-1 tests in `tests/chord.rs` — 10 tests, green under `cargo test`:
pure-JI beatlessness, 31-TET near-just third vs weak fifth, the 12-TET ~10.4 Hz
wobble, the BP wrong-ratio-set failure, ordinal-on-a-mode vs ordinal-cluster-on-an-
equal-division, the cents-based no-triad guard, and end-to-end `.scl` → route →
triad for 12-TET / JI-major / 5-TET-degrades-to-dyad.)
