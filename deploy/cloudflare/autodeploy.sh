#!/bin/sh
# Host-side auto-deploy (docs/deploy.md). The systemd user timer telly-autodeploy runs this every
# 60 s: when origin/main moved, it releases the new commit with deploy/cloudflare/release.sh from its
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
if TELLY_RELEASE_MODULE_ONLY=${mode:+1} sh deploy/cloudflare/release.sh; then
	echo "$new" >"$state/deployed"
else
	echo "$new" >"$state/failed"
	echo "autodeploy: RELEASE OF $new FAILED; live keeps $(cat "$state/deployed" 2>/dev/null || echo 'the previous deploy')" >&2
	exit 1
fi
