#!/bin/sh
# Container start for the Telly API on Cloudflare (deploy/cloudflare/deploy.sh). Pulls only the keys
# in TELLY_PULL_KEYS from the shared key Worker into a mode-600 file, then starts the server with it.
# The pull token reaches only the pull file; the server never sees it. See docs/cloudflare-keys.md.
set -eu
umask 077
mkdir -p "$HOME/.config/telly"
printf 'TELLY_SECRETS_URL=%s\nTELLY_SECRETS_PULL_TOKEN=%s\n' \
	"$TELLY_SECRETS_URL" "$TELLY_SECRETS_PULL_TOKEN" >"$HOME/.config/telly/secrets-pull.env"
unset TELLY_SECRETS_PULL_TOKEN
node scripts/cloudflare-keys.ts pull /tmp/telly.env "$TELLY_PULL_KEYS"
exec node --env-file=/tmp/telly.env index.mjs
