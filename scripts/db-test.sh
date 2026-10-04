#!/bin/sh
# Starts an isolated, in-memory SpacetimeDB on 127.0.0.1, publishes the module from spacetimedb/,
# and runs the database tests against it. Nothing is published to a cloud server, and nothing
# outlives the run. The publisher is a new identity that this local database issues, logged in
# through a CLI config in the temporary directory; the module makes it the alert delivery operator.
# Needs the `spacetime` CLI (https://spacetimedb.com/install) and curl.
# Usage: bun run db:test   (SPACETIMEDB_PORT picks the port; default 3399)
set -eu
cd "$(git rev-parse --show-toplevel)"
port=${SPACETIMEDB_PORT:-3399}
server="http://127.0.0.1:$port"
if spacetime server ping "$server" >/dev/null 2>&1; then
	echo "db:test: another server already listens on $server; set SPACETIMEDB_PORT" >&2
	exit 1
fi
data=$(mktemp -d)
log="$data/server.log"
spacetime start --in-memory --non-interactive --data-dir "$data" --listen-addr "127.0.0.1:$port" >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$data"' EXIT
tries=0
until spacetime server ping "$server" >/dev/null 2>&1; do
	tries=$((tries + 1))
	if [ "$tries" -ge 100 ] || ! kill -0 "$pid" 2>/dev/null; then
		cat "$log"
		echo "db:test: SpacetimeDB did not start on $server" >&2
		exit 1
	fi
	sleep 0.2
done
token=$(curl -fsS -X POST "$server/v1/identity" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
spacetime --config-path "$data/cli.toml" login --token "$token" >/dev/null
spacetime --config-path "$data/cli.toml" publish --server "$server" --module-path spacetimedb --yes health-test
# reliability.test.ts runs the built server under Node.
bun run --filter server build >/dev/null
SPACETIMEDB_URI="ws://127.0.0.1:$port" SPACETIMEDB_DATABASE=health-test SPACETIMEDB_OPERATOR_TOKEN="$token" \
	bun test apps/server/src/db.test.ts apps/server/src/auth.test.ts apps/server/src/alerts/outbox.test.ts \
	apps/server/src/routes/alerts.test.ts apps/server/src/reliability.test.ts \
	apps/server/src/routes/reports.test.ts apps/server/src/routes/finchnode.test.ts \
	apps/server/src/routes/tools.test.ts apps/server/src/routes/healthkit.test.ts \
	apps/server/src/routes/trends.test.ts \
	apps/server/src/routes/appointments.test.ts \
	apps/server/src/routes/chat.test.ts apps/server/src/routes/care.test.ts \
	apps/server/src/routes/meal-facts.test.ts apps/server/src/routes/care-profile.test.ts \
	apps/server/src/routes/exercise.test.ts apps/server/src/routes/reminders.test.ts \
	apps/server/src/routes/emergency.test.ts \
	apps/server/src/routes/speaker.test.ts \
	apps/server/src/routes/trips.test.ts \
	apps/server/src/routes/delivery.test.ts \
	apps/server/src/routes/location.test.ts
