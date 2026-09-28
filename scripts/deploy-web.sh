#!/usr/bin/env bash
# Build the browser studio and stage it for swwallowws/starling-web (formerly voxmpe-web).
#   scripts/deploy-web.sh --stage DIR       build and stage into DIR (no git)
#   scripts/deploy-web.sh --push CHECKOUT   stage into a clone of starling-web, commit, push
# Pushing publishes the site: only with Bengisu's explicit go.
set -euo pipefail

mode="${1:-}"; target="${2:-}"
if [[ "$mode" != "--stage" && "$mode" != "--push" ]] || [[ -z "$target" ]]; then
  echo "usage: $0 --stage DIR | --push CHECKOUT" >&2; exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"

npm --prefix "$root/studio-ui" run build:web

mkdir -p "$target"
find "$target" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$root/studio-ui/web-dist/." "$target/"
cp "$root/web/deploy/README.md" "$root/web/deploy/LICENSE" "$target/"
{
  cat "$root/web/deploy/NOTICE"
  # Drop cargo's markers ("(/path)", "(ssh://...)", "(proc-macro)", repeat "(*)") but
  # keep parenthesized license expressions; voxmpe's own crates are not third party.
  cargo tree --manifest-path "$root/Cargo.toml" -p voxmpe-web --target wasm32-unknown-unknown \
    -e normal --prefix none --format "{p} {l}" \
    | sed -E 's/ \((\/[^)]*|ssh:[^)]*|proc-macro|\*)\)//g; s/ +$//' \
    | grep -v '^voxmpe' | sort -u
} > "$target/NOTICE"
touch "$target/.nojekyll"

if [[ "$mode" == "--push" ]]; then
  git -C "$target" add -A
  git -C "$target" commit -m "Deploy voxmpe $(git -C "$root" rev-parse --short HEAD)"
  git -C "$target" push
fi
echo "staged in $target"
