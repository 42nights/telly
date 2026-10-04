#!/bin/sh
# Sentrux cannot exclude paths, and noop/ is a separate project. Copy the app's tracked and
# untracked-but-not-ignored files (everything outside noop/) into a temporary directory and run
# the rules and the regression gate there. Pass --save to move .sentrux/baseline.json in a
# reviewed commit.
# packages/db/src/types/reducers.ts is left out: `spacetime generate` writes it with one import per
# reducer, so its fan-out grows with the module, not with hand-written design. The static pages in
# deploy/cloudflare/landing/ are left out: their footer links each other, which is not a code cycle.
# Every other generated and hand-written file stays checked.
set -eu
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$root"
git ls-files -co --exclude-standard -- . ':!noop' ':!packages/db/src/types/reducers.ts' \
	':!deploy/cloudflare/landing' |
	tar -cf - -T - | tar -xf - -C "$tmp"
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
