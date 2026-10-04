#!/bin/sh
# Pack the built server and web app into health.tar.gz, the one artifact that CD deploys
# (.github/workflows/health-deploy.yml). Run `bun run --filter server build` and
# `bun run --filter web build` first. Usage: sh scripts/pack-health.sh [out.tar.gz]
set -eu
out=$(realpath -m "${1:-health.tar.gz}")
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$root"
mkdir -p "$tmp/server/node_modules/.bin" "$tmp/server/scripts"
# index.mjs imports the build's other chunks (rolldown splits dynamic imports), so ship all of dist/.
cp apps/server/dist/*.mjs apps/server/.env.schema "$tmp/server/"
cp -R apps/web/dist "$tmp/web"
# The live commit, served at /version.txt on the web host.
git rev-parse HEAD >"$tmp/web/version.txt"
# The key pull (docs/cloudflare-keys.md) runs under Node at container start.
cp apps/server/scripts/cloudflare-keys.ts "$tmp/server/scripts/"
cp -RL apps/server/node_modules/varlock "$tmp/server/node_modules/varlock"
ln -s ../varlock/bin/cli.js "$tmp/server/node_modules/.bin/varlock"
# The bundled iMessage client checks at start that its gRPC peers resolve from node_modules.
imessage_deps=$(realpath apps/server/node_modules/@spectrum-ts/imessage/../..)
mkdir -p "$tmp/server/node_modules/@grpc"
cp -RL "$imessage_deps/nice-grpc" "$imessage_deps/nice-grpc-common" "$tmp/server/node_modules/"
cp -RL "$imessage_deps/@grpc/grpc-js" "$tmp/server/node_modules/@grpc/"
tar -czf "$out" -C "$tmp" .
echo "packed $out"
