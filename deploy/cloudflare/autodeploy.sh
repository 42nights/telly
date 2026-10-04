#!/bin/sh
# Host-side auto-deploy (docs/deploy.md) while CI deploy is skipped. The systemd user timer
# telly-autodeploy runs this every 60 s: when origin/main moved, it releases the new commit with
# deploy/cloudflare/release.sh from its own clone. One run at a time (flock). A failed commit is
# not retried; the next commit on main is.
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
echo "autodeploy: releasing $new"
if sh deploy/cloudflare/release.sh; then
	echo "$new" >"$state/deployed"
else
	echo "$new" >"$state/failed"
	echo "autodeploy: RELEASE OF $new FAILED; live keeps $(cat "$state/deployed" 2>/dev/null || echo 'the previous deploy')" >&2
	exit 1
fi
