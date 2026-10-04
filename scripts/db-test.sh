#!/bin/sh
# Starts an isolated, in-memory SpacetimeDB on 127.0.0.1, publishes the module from spacetimedb/,
# and runs the database tests against it. Nothing is published to a cloud server, and nothing
# outlives the run. Needs the `spacetime` CLI (https://spacetimedb.com/install).
# Usage: bun run db:test   (SPACETIMEDB_PORT picks the port; default 3399)
set -eu
cd "$(git rev-parse --show-toplevel)"
port=${SPACETIMEDB_PORT:-3399}
server="http://127.0.0.1:$port"
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
spacetime publish --server "$server" --module-path spacetimedb --anonymous --yes health-test
SPACETIMEDB_URI="ws://127.0.0.1:$port" SPACETIMEDB_DATABASE=health-test \
	bun test apps/server/src/db.test.ts apps/server/src/auth.test.ts apps/server/src/routes/tools.test.ts
