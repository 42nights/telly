// Seeds one family with the real WHOOP readings in data/whoop/ (see its README) through the NOOP
// relay contract: the same `recordSample` rows a live push writes, from the same mapping. That is
// one heart rate per device-minute, wrist on/off events, and the app's computed daily scores. Values
// stay as recorded and gaps stay gaps. A re-run records nothing that is already stored.
// The other tables in data/whoop/ have no stored form in the contract, so they are not written.
//
// Usage: bun apps/server/scripts/seed-whoop.ts [familyId]
//   SPACETIMEDB_URI, SPACETIMEDB_DATABASE: the database, e.g. wss://maincloud.spacetimedb.com, telly.
//   WHOOP_SEED_TOKEN: a SpacetimeDB token of a member of the family. Without it the database issues
//   a new identity; a family admin adds it with `POST /api/families/<id>/members`.
//   Without familyId, the script prints its identity and its families, and writes nothing.
import { readFileSync } from "node:fs";
import { NoopBatch } from "@health/contracts";
import { Effect, Schema } from "effect";
import { openFamilyDb } from "../src/db";
import {
	noopTableSamples,
	recordNoopSamples,
} from "../src/integrations/noop-ingest";

// Pace for a shared database: reducer calls go one at a time, with a pause after each chunk.
const CHUNK = 500;
const PAUSE_MS = 1_000;

const { SPACETIMEDB_URI: uri, SPACETIMEDB_DATABASE: database } = process.env;
if (!uri || !database)
	throw new Error("Set SPACETIMEDB_URI and SPACETIMEDB_DATABASE");
const token = process.env.WHOOP_SEED_TOKEN || undefined;
const familyArg = process.argv[2];

const table = (name: string): unknown =>
	JSON.parse(
		readFileSync(
			new URL(`../../../data/whoop/${name}.json`, import.meta.url),
			"utf8",
		),
	);

const { tables } = Schema.decodeUnknownSync(NoopBatch)({
	tables: {
		hrSample: table("hrSample"),
		event: table("event"),
		dailyMetric: table("dailyMetric"),
	},
});
const samples = noopTableSamples(tables);

await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const db = yield* openFamilyDb({
				uri,
				database,
				...(token === undefined ? {} : { token }),
			});
			console.log(`identity ${db.identity}`);
			if (token === undefined)
				console.log(`token (WHOOP_SEED_TOKEN) ${db.token}`);
			const families = [...db.connection.db.myFamilies.iter()];
			for (const f of families) console.log(`family ${f.id} ${f.name}`);
			if (familyArg === undefined) return;
			const familyId = BigInt(familyArg);
			if (!families.some((f) => f.id === familyId))
				throw new Error(
					`identity ${db.identity} is not a member of family ${familyId}`,
				);
			const record = recordNoopSamples(db, familyId);
			const count = () =>
				[...db.connection.db.myHealthSamples.iter()].filter(
					(s) => s.familyId === familyId,
				).length;
			const before = count();
			for (let i = 0; i < samples.length; i += CHUNK) {
				yield* Effect.promise(() => record(samples.slice(i, i + CHUNK)));
				console.log(
					`${Math.min(i + CHUNK, samples.length)}/${samples.length} checked, ${count()} stored`,
				);
				yield* Effect.sleep(PAUSE_MS);
			}
			console.log(`family ${familyId}: ${count() - before} new samples`);
		}),
	),
);
process.exit(0);
