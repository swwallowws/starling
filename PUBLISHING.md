# Publishing checklist

Before flipping `swwallowws/starling` (formerly `voxmpe`) from private to public. Audited 2026-09-26 on
`main`, 62 commits, one branch (`main`, same as `origin/main`).

Status: **ready to flip once the open items below are decided.** Nothing in the
history needs rewriting.

## History audit

- [x] **No audio, MIDI, Live sets or model weights ever committed.** Checked every
  file in every commit (`git log --all --name-only`) for `*.wav`, `*.mp3`,
  `*.flac`, `*.m4a`, `*.mid`, `*.als`, `*.pt`, `*.onnx`, `*.h5`, `*.safetensors`,
  `*.tgz`, and `takes/` or recordings folders. None. Tests build their audio
  synthetically; takes have always lived in the gitignored `takes/`.
- [x] **No vendored SDKs.** No Ableton Extensions SDK tarballs or other
  third-party SDKs in any commit.
- [x] **No secrets.** Grepped every commit (lockfiles excluded, their integrity
  hashes match anything) for `sk-`, `ghp_`, `hf_`, `AKIA`, `xoxb-`,
  `BEGIN ... PRIVATE KEY`, `api_key`, `password`, `secret`, `token`, `bearer`.
  Only hits are test names (`../secret.wav` in `crates/voxmpe/tests/server.rs`),
  the word `password` as an input type in `studio-ui/src/keys.ts`, and colour
  "tokens" in the design system.
- [x] **No absolute home paths** (`/Users/...`) in any commit.
- [x] **Author identity becomes public.** Every commit has author and committer
  `Bikem <bengisuozaydin@gmail.com>`. Intended (decided 2026-09-30).

## Current tree

- [x] `LICENSE`: MIT, `Copyright (c) 2026 Bengisu Ozaydin`.
- [x] `license = "MIT"` in `crates/voxmpe/Cargo.toml`,
  `crates/voxmpe-core/Cargo.toml`, `crates/voxmpe-web/Cargo.toml`, and
  `"license": "MIT"` in `studio-ui/package.json` (and its lockfile). No
  pyproject.
- [x] README states the licences of what the project uses: CREPE weights and
  torchcrepe (MIT, exported locally, never committed) and the vendored fonts in
  `studio-ui/vendor/design/fonts` (Inter Tight and Geist Mono, OFL 1.1, licence
  texts committed next to them).
- [x] `.gitignore` covers `takes/`, `models/*.onnx`, build output, and now also a
  safety net for audio, MIDI, `.als` and weight files anywhere, plus
  `node_modules/`, `.venv/`, `__pycache__/`, `.claude/` and `.superpowers/`.
- [x] **`web/deploy/LICENSE` now carries MIT** (it said "All rights reserved"
  since `b42a4fc`). `scripts/deploy-web.sh` copies it into the public
  `starling-web` site repo, so the live site keeps the old text until the next
  deploy.
- [x] **Stale privacy notes in the plans.** `docs/superpowers/` (plans that said
  "the source stays private" and described working instructions) is removed
  from the tree (2026-09-30); it stays in history, which is fine.
- [x] **No em dashes in prose** (`MICROTONAL_SPEC.md`'s 46, 2026-09-30).
- [x] **Old branch** `showcase-embed` deleted on GitHub (merged).
- [x] `studio-ui/vendor/design/` is your own shared design system (v1.0.0), so it
  falls under this repo's MIT licence.

## Dependencies

- [x] **`expressive-liveset` is public (2026-09-29).** `crates/voxmpe/Cargo.toml`
  pulls it over HTTPS (`https://github.com/swwallowws/expressive-liveset.git`,
  rev `034837d72666c89493c6471af3a342cbe6d1d8c4`, the first public commit, same
  code as the earlier private pin `f96160e`), so anyone can build without an SSH
  key. The `git-fetch-with-cli` setting is gone from `.cargo/config.toml`. It has
  an MIT `LICENSE` and a clean, re-saved Live template.

## Tests (2026-09-26)

- `cargo test --release --workspace`: 99 tests and 2 doctests, all pass (run
  with the CREPE model present, so the model tests ran).
- `npm test` in `studio-ui`: 21 files, 101 tests, all pass.

## Options if the history ever needs cleaning

Not needed today. If the author email or anything else in history must go:

1. **Fresh squashed repo:** create a new repo from the current tree as a single
   commit and publish that one instead. Simplest, loses history.
2. **`git filter-repo`:** rewrite this repo (for example `--mailmap` for the
   author email, or `--path ... --invert-paths` for a file), then force-push.
   Keeps history, changes every hash, and every other clone must re-clone.
