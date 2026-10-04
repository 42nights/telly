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
cp -R "$here/landing" "$tmp/web/landing"

$wrangler containers registries credentials registry.cloudflare.com --push --pull --json >"$tmp/registry.json"
jq -j .password "$tmp/registry.json" |
	crane auth login registry.cloudflare.com -u "$(jq -r .username "$tmp/registry.json")" --password-stdin
tar -cf "$tmp/layer.tar" --sort=name --mtime=@0 --owner=1000 --group=1000 \
	--transform 's,^server,app,' -C "$tmp" server
# The layer and base digests name the image: the same artifact, entrypoint, and base give the same
# image, so a rollback redeploys the image it built.
repo="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/telly-api"
base="node:24-slim@$(crane digest --platform linux/amd64 node:24-slim)"
hash=$({ sha256sum "$tmp/layer.tar"; echo "$base"; } | sha256sum | cut -c1-16)
image="$repo:$hash"
# The final tag is written once, with the entrypoint already set. Writing the unmutated image to it
# first let instances start plain `node`, which exits 0 at once (a crash loop, #210).
crane append --platform linux/amd64 -b "$base" -f "$tmp/layer.tar" -t "$repo:build-$hash"
crane mutate --entrypoint /bin/sh,/app/entrypoint.sh --workdir /app --user node -t "$image" \
	"$repo:build-$hash"
[ "$(crane config "$image" | jq -c .config.Entrypoint)" = '["/bin/sh","/app/entrypoint.sh"]' ] ||
	{ echo "deploy: $image does not start /app/entrypoint.sh; not deployed" >&2; exit 1; }

# TELLY_DEPLOY_ID changes on every deploy, so the Worker starts a new container with new settings.
# max_instances 2: the new deploy's container starts while the previous one is still stopping.
# run_worker_first: every request runs the Worker first, so it can serve the landing page on
# LANDING_HOST. ponytail: each asset request then counts against the Workers request quota; move the
# landing to an assets-only Worker if traffic nears it.
jq -n --arg image "$image" --arg web "$tmp/web" --arg id "$(date -u +%Y%m%dT%H%M%SZ)" '{
	name: "telly",
	main: "worker.js",
	compatibility_date: "2026-09-01",
	workers_dev: true,
	preview_urls: false,
	observability: { enabled: true },
	assets: { directory: $web, binding: "ASSETS", not_found_handling: "single-page-application",
		run_worker_first: true },
	containers: [{ class_name: "Api", image: $image, max_instances: 2, instance_type: "basic" }],
	durable_objects: { bindings: [{ name: "API", class_name: "Api" }] },
	migrations: [{ tag: "v1", new_sqlite_classes: ["Api"] }],
	vars: (env | {TELLY_DEPLOY_ID: $id} + with_entries(select(.key | IN(
		"CORS_ORIGIN", "LANDING_HOST", "TELLY_SECRETS_URL", "TELLY_PULL_KEYS", "OIDC_ISSUER", "OIDC_AUDIENCE", "SPACETIMEDB_URI",
		"SPACETIMEDB_DATABASE", "FINCHNODE_MODE", "TELLY_R2_ACCOUNT_ID", "TELLY_R2_BUCKET",
		"TELLY_R2_ACCESS_KEY_ID", "QWEN_BASE_URL", "QWEN_BASE_MODEL", "QWEN_CHECKPOINT")))),
}' >"$tmp/wrangler.json"
jq -n '{TELLY_SECRETS_PULL_TOKEN: env.TELLY_SECRETS_PULL_TOKEN}' >"$tmp/secrets.json"
$wrangler deploy --config "$tmp/wrangler.json" --secrets-file "$tmp/secrets.json" \
	--containers-rollout immediate
echo "deployed $image"

# Deploy success only starts the container rollout, and until it finishes the old instances still
# answer. Wait for it, then require /health 200 within 2 minutes; otherwise fail, so the caller rolls
# back (deploy/cloudflare/autodeploy.sh) or the CI job goes red.
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/containers/applications"
cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$1"; }
app=$(cf "$api" | jq -r '.result[] | select(.name == "telly-api") | .id')
deadline=$(($(date +%s) + 600))
until [ "$(cf "$api/$app/rollouts" | jq -r '.result[0].status')" = completed ]; do
	[ "$(date +%s)" -lt "$deadline" ] || { echo "deploy: container rollout did not finish in 10 min" >&2; exit 1; }
	sleep 10
done
deadline=$(($(date +%s) + 120))
until [ "$(curl -s -m 70 -o /dev/null -w '%{http_code}' "$HEALTH_SERVER_URL/health")" = 200 ]; do
	[ "$(date +%s)" -lt "$deadline" ] || { echo "deploy: $HEALTH_SERVER_URL/health is not 200 within 2 min" >&2; exit 1; }
	sleep 5
done
echo "healthy $HEALTH_SERVER_URL"
