#!/bin/sh
# Release the checked-out commit to the live Telly (docs/deploy.md): publish the SpacetimeDB module
# to Maincloud, then build, pack, and deploy the Worker `telly`. Use it while CI deploy is skipped.
# Usage: sh deploy/cloudflare/release.sh
# Needs bun, jq, crane, and spacetime on PATH, and these mode-600 files (values are never printed):
#   ~/.config/telly/deploy-42nights.env   CLOUDFLARE_API_TOKEN (Workers Scripts + Containers Write)
#   ~/.config/telly/secrets-pull.env      TELLY_SECRETS_PULL_TOKEN (docs/cloudflare-keys.md)
#   $TELLY_SPACETIME_CONFIG               a SpacetimeDB CLI login that owns the database `telly`
#                                         (default ~/.config/telly/spacetime/cli.toml)
# The module publish never deletes data. If it needs a wipe or breaks clients, it stops at its
# prompt (stdin is closed), and this script stops before the Worker deploy. deploy.sh fails when
# /health is not 200 within 2 minutes of the container rollout.
# TELLY_RELEASE_PART=module publishes only the module. TELLY_RELEASE_KEEP=<path> keeps a copy of
# the deployed artifact there after a healthy deploy (autodeploy.sh rolls back to it).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
config="$HOME/.config/telly"
value() { sed -n "s/^$1=//p" "$2"; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bun install --frozen-lockfile
spacetime --config-path "${TELLY_SPACETIME_CONFIG:-$config/spacetime/cli.toml}" \
	publish telly -s maincloud --module-path spacetimedb --yes=remote </dev/null ||
	{ echo "release: module publish refused (needs a data wipe or breaks clients?); Worker not deployed" >&2; exit 1; }
if [ "${TELLY_RELEASE_PART:-}" = module ]; then
	echo "release: module published; Worker left to CI"
	exit 0
fi
bun run --filter server build
(
	set -a; . deploy/cloudflare/settings.env; set +a
	NODE_ENV=production VITE_SERVER_URL="$HEALTH_SERVER_URL" VITE_OIDC_ISSUER="$OIDC_ISSUER" \
		VITE_OIDC_CLIENT_ID="$OIDC_AUDIENCE" bun run --filter web build
)
sh scripts/pack-health.sh "$tmp/health.tar.gz"
CLOUDFLARE_API_TOKEN=$(value CLOUDFLARE_API_TOKEN "$config/deploy-42nights.env") \
	TELLY_SECRETS_PULL_TOKEN=$(value TELLY_SECRETS_PULL_TOKEN "$config/secrets-pull.env") \
	sh deploy/cloudflare/deploy.sh "$tmp/health.tar.gz"
node apps/server/scripts/smoke.ts "$(value HEALTH_SERVER_URL deploy/cloudflare/settings.env)"
[ -z "${TELLY_RELEASE_KEEP:-}" ] || cp "$tmp/health.tar.gz" "$TELLY_RELEASE_KEEP"
echo "released $(git rev-parse HEAD)"
