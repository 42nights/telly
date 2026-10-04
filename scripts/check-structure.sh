#!/bin/sh
# Sentrux cannot exclude paths, and noop/ is a separate project. Copy the app's tracked and
# untracked-but-not-ignored files (everything outside noop/ and the generated bindings in
# packages/db/src, which Biome also skips) into a temporary directory and run the rules and the
# regression gate there. Fallow still checks every import of packages/db. Pass --save to move
# .sentrux/baseline.json in a reviewed commit.
set -eu
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$root"
git ls-files -co --exclude-standard -- . ':!noop' ':!packages/db/src' | tar -cf - -T - | tar -xf - -C "$tmp"
cd "$tmp"
# Sentrux reads the file list from git; without a repository it walks the tree differently.
git init -q && git add -A
if [ "${1:-}" = --save ]; then
	sentrux gate --save .
	cp .sentrux/baseline.json "$root/.sentrux/baseline.json"
else
	sentrux check .
	sentrux gate .
fi
