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
# A page that stays open across a deploy still loads the lazy chunks of its own build: assets.txt
# lists this build's hashed files, and the next deploy copies the files that the live list names.
# Only one previous build is kept, because a copied file is not in the new list.
(cd "$tmp/web" && find assets -type f | sort >assets.txt)
live="https://app.$LANDING_HOST"
curl -fsS -m 30 "$live/assets.txt" 2>/dev/null | grep -E '^assets/[A-Za-z0-9._-]+$' |
	while read -r file; do
		[ -e "$tmp/web/$file" ] || curl -fsS -m 30 -o "$tmp/web/$file" "$live/$file" ||
			rm -f "$tmp/web/$file"
	done || true

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

api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api$1"; }
jq -n '{TELLY_SECRETS_PULL_TOKEN: env.TELLY_SECRETS_PULL_TOKEN}' >"$tmp/secrets.json"

# Deploys the image and web app as Worker $1, waits for its container rollout, then requires the
# signed-out smoke on $2 within 2 minutes.
# TELLY_DEPLOY_ID changes on every deploy, so the Worker starts a new container with new settings.
# max_instances 2: the new deploy's container starts while the previous one is still stopping.
# run_worker_first: every request runs the Worker first, so it can serve the landing page on
# LANDING_HOST. ponytail: each asset request then counts against the Workers request quota; move the
# landing to an assets-only Worker if traffic nears it.
# triggers: only `telly` pings its API every 5 minutes (worker.js `scheduled`), so its one basic
# container never sleeps; that costs about $8 a month (docs/deploy.md). The candidate gets no cron.
ship() {
	jq -n --arg name "$1" --arg image "$image" --arg web "$tmp/web" --arg id "$(date -u +%Y%m%dT%H%M%SZ)" '{
		name: $name,
		main: "worker.js",
		compatibility_date: "2026-09-01",
		workers_dev: true,
		preview_urls: false,
		observability: { enabled: true },
		assets: { directory: $web, binding: "ASSETS", run_worker_first: true },
		containers: [{ class_name: "Api", image: $image, max_instances: 2, instance_type: "basic" }],
		durable_objects: { bindings: [{ name: "API", class_name: "Api" }] },
		migrations: [{ tag: "v1", new_sqlite_classes: ["Api"] }],
		triggers: { crons: (if $name == "telly" then ["*/5 * * * *"] else [] end) },
		vars: (env | {TELLY_DEPLOY_ID: $id} + with_entries(select(.key | IN(
			"CORS_ORIGIN", "LANDING_HOST", "TELLY_SECRETS_URL", "TELLY_PULL_KEYS", "OIDC_ISSUER", "OIDC_AUDIENCE", "SPACETIMEDB_URI",
			"SPACETIMEDB_DATABASE", "FINCHNODE_MODE", "TELLY_R2_ACCOUNT_ID", "TELLY_R2_BUCKET",
			"TELLY_R2_ACCESS_KEY_ID", "SPECTRUM_PROJECT_ID", "QWEN_BASE_URL", "QWEN_BASE_MODEL", "QWEN_CHECKPOINT",
			"TELLY_FETCH_BRIDGE_URL", "TELLY_IMESSAGE_ADDRESS")))),
	}' >"$tmp/wrangler.json" || return 1
	# `set -e` is off inside a function called with `||`, so each step returns on failure.
	$wrangler deploy --config "$tmp/wrangler.json" --secrets-file "$tmp/secrets.json" \
		--containers-rollout immediate || return 1
	echo "deployed $image to $1"
	# Deploy success only starts the container rollout; until it finishes the old instances answer.
	# A new container application has no rollout yet.
	app=$(cf /containers/applications | jq -r --arg app "$1-api" '.result[] | select(.name == $app) | .id')
	[ -n "$app" ] || { echo "deploy: no container application $1-api" >&2; return 1; }
	deadline=$(($(date +%s) + 600))
	until [ "$(cf "/containers/applications/$app/rollouts" | jq -r '.result[0].status // "completed"')" = completed ]; do
		[ "$(date +%s)" -lt "$deadline" ] || { echo "deploy: $1 container rollout did not finish in 10 min" >&2; return 1; }
		sleep 10
	done
	deadline=$(($(date +%s) + 120))
	until smoke "$2"; do
		[ "$(date +%s)" -lt "$deadline" ] || { echo "deploy: $2 failed the smoke check for 2 min" >&2; return 1; }
		sleep 5
	done
	echo "healthy $2"
}

# Signed out: the API is up, routes, and refuses an unsigned caller; the web app is served.
smoke() {
	[ "$(curl -s -m 70 "$1/health" | jq -r .status 2>/dev/null)" = ok ] &&
		[ "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$1/api/sources")" = 200 ] &&
		[ "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$1/api/me")" = 401 ] &&
		curl -s -m 30 "$1/" | grep -q '<script type="module"'
}

# Verify before users see it. Cloudflare has no unpromoted version of a Worker with containers
# (`wrangler versions upload` publishes no image, and such Workers get no version URLs), so the
# candidate is a separate Worker, `telly-candidate`, with its own container application, on its
# workers.dev address only. It runs this exact image with the production settings and keys. Only if
# it passes does `telly` get the same image; a failing build never reaches the live Worker.
# ponytail: the candidate's container keeps running between deploys (max 2 basic instances).
subdomain=$(cf /workers/subdomain | jq -r .result.subdomain)
ship telly-candidate "https://telly-candidate.$subdomain.workers.dev" ||
	{ echo "deploy: the candidate failed; $HEALTH_SERVER_URL is unchanged" >&2; exit 1; }
# Last-resort guard: the live Worker still has to pass the same check after its own rollout.
ship telly "$HEALTH_SERVER_URL"
