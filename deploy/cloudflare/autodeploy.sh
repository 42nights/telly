#!/bin/sh
# Host-side auto-deploy (docs/deploy.md). The systemd user timer telly-autodeploy runs this every
# 2 minutes: when origin/main moved, it releases the new commit with deploy/cloudflare/release.sh from its
# own clone. One run at a time (flock). A failed commit is not retried; the next commit on main is.
# CI (health-deploy) owns the Worker deploy of a commit when its `deploy` job ran: this waits while
# that commit's run is unfinished, and after a successful CI deploy it publishes only the module.
set -eu
checkout=${TELLY_AUTODEPLOY_CHECKOUT:-$HOME/.local/share/telly-autodeploy/telly}
state=$HOME/.local/state/telly-autodeploy
mkdir -p "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0
cd "$checkout"
git fetch -q origin main
new=$(git rev-parse origin/main)
for done in deployed failed; do
	[ "$(cat "$state/$done" 2>/dev/null)" != "$new" ] || exit 0
done
git reset -q --hard "$new"
if [ ! -f deploy/cloudflare/release.sh ]; then
	echo "autodeploy: $new has no deploy/cloudflare/release.sh; skipped"
	exit 0
fi
repo=ayaangazali/telly
mode=
for run in $(gh api "repos/$repo/actions/workflows/health-deploy.yml/runs?head_sha=$new" \
	--jq '.workflow_runs[] | "\(.id):\(.status)"'); do
	if [ "${run#*:}" != completed ]; then
		echo "autodeploy: CI run ${run%%:*} for $new is ${run#*:}; checking again next tick"
		exit 0
	fi
	[ "$(gh api "repos/$repo/actions/runs/${run%%:*}/jobs" \
		--jq '.jobs[] | select(.name == "deploy") | .conclusion')" != success ] || mode=module
done
echo "autodeploy: releasing $new${mode:+ (module only; CI deployed the Worker)}"
if TELLY_RELEASE_PART=$mode TELLY_RELEASE_KEEP="$state/good.tar.gz.new" sh deploy/cloudflare/release.sh; then
	[ ! -f "$state/good.tar.gz.new" ] || mv "$state/good.tar.gz.new" "$state/good.tar.gz"
	echo "$new" >"$state/deployed"
	exit 0
fi
echo "$new" >"$state/failed"
echo "autodeploy: RELEASE OF $new FAILED" >&2
# A failed release that left the API unhealthy goes back to the last healthy artifact.
url=$(sed -n 's/^HEALTH_SERVER_URL=//p' deploy/cloudflare/settings.env)
if [ "$(curl -s -m 70 -o /dev/null -w '%{http_code}' "$url/health")" != 200 ] && [ -f "$state/good.tar.gz" ]; then
	echo "autodeploy: $url/health is down; ROLLING BACK to $(cat "$state/deployed" 2>/dev/null)" >&2
	CLOUDFLARE_API_TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$HOME/.config/telly/deploy-42nights.env") \
		TELLY_SECRETS_PULL_TOKEN=$(sed -n 's/^TELLY_SECRETS_PULL_TOKEN=//p' "$HOME/.config/telly/secrets-pull.env") \
		sh deploy/cloudflare/deploy.sh "$state/good.tar.gz"
fi
exit 1
