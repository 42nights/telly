#!/bin/sh
# Deploy one health.tar.gz (scripts/pack-health.sh) to the 42nights Cloudflare account as the Worker
# `telly`: web/ as static assets, server/ as a Cloudflare Container image. No Docker is needed: crane
# appends the server to node:24-slim and pushes it to the Cloudflare registry.
# Usage: sh deploy/cloudflare/deploy.sh health.tar.gz
# Needs crane, jq, and bun on PATH. Public settings come from settings.env next to this script.
# Secrets come from the environment:
#   CLOUDFLARE_API_TOKEN      42nights token with Workers Scripts and Workers Containers Write
#   TELLY_SECRETS_PULL_TOKEN  the shared key Worker's pull token (docs/cloudflare-keys.md)
set -eu
umask 077
artifact=$(realpath "$1")
here=$(cd "$(dirname "$0")" && pwd)
set -a
. "$here/settings.env"
set +a
wrangler="bunx wrangler@4.147.0"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export DOCKER_CONFIG="$tmp/docker"

tar -xzf "$artifact" -C "$tmp"
cp "$here/entrypoint.sh" "$tmp/server/"
cp "$here/worker.js" "$tmp/"
# The artifact digest names the image, so a rollback redeploys the exact image it built.
image="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/telly-api:$(sha256sum "$artifact" | cut -c1-16)"

$wrangler containers registries credentials registry.cloudflare.com --push --pull --json >"$tmp/registry.json"
jq -j .password "$tmp/registry.json" |
	crane auth login registry.cloudflare.com -u "$(jq -r .username "$tmp/registry.json")" --password-stdin
tar -cf "$tmp/layer.tar" --owner=1000 --group=1000 --transform 's,^server,app,' -C "$tmp" server
crane append --platform linux/amd64 -b node:24-slim -f "$tmp/layer.tar" -t "$image"
crane mutate --entrypoint /bin/sh,/app/entrypoint.sh --workdir /app --user node -t "$image" "$image"

# TELLY_DEPLOY_ID changes on every deploy, so the Worker restarts the container with new settings.
jq -n --arg image "$image" --arg web "$tmp/web" --arg id "$(date -u +%Y%m%dT%H%M%SZ)" '{
	name: "telly",
	main: "worker.js",
	compatibility_date: "2026-09-01",
	workers_dev: true,
	preview_urls: false,
	observability: { enabled: true },
	assets: { directory: $web, binding: "ASSETS", not_found_handling: "single-page-application",
		run_worker_first: ["/api/*", "/health"] },
	containers: [{ class_name: "Api", image: $image, max_instances: 1, instance_type: "basic" }],
	durable_objects: { bindings: [{ name: "API", class_name: "Api" }] },
	migrations: [{ tag: "v1", new_sqlite_classes: ["Api"] }],
	vars: (env | {CORS_ORIGIN: .HEALTH_SERVER_URL, TELLY_DEPLOY_ID: $id} + with_entries(select(.key | IN(
		"TELLY_SECRETS_URL", "TELLY_PULL_KEYS", "OIDC_ISSUER", "OIDC_AUDIENCE", "SPACETIMEDB_URI",
		"SPACETIMEDB_DATABASE", "FINCHNODE_MODE")))),
}' >"$tmp/wrangler.json"
jq -n '{TELLY_SECRETS_PULL_TOKEN: env.TELLY_SECRETS_PULL_TOKEN}' >"$tmp/secrets.json"
$wrangler deploy --config "$tmp/wrangler.json" --secrets-file "$tmp/secrets.json" \
	--containers-rollout immediate
echo "deployed $image"
