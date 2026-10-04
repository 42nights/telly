// Runs against a real local SpacetimeDB with the module published: `bun run db:test` starts an
// isolated in-memory database, publishes, sets SPACETIMEDB_URI and SPACETIMEDB_DATABASE, and runs
// this file. Each connection below is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Identity, Timestamp } from "spacetimedb";
import { type DbConfig, openFamilyDb, readFamilyRecords } from "./db";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const config: DbConfig | undefined =
	uri && database ? { uri, database } : undefined;

const run = (
	body: (config: DbConfig) => Effect.Effect<void, unknown, never>,
) =>
	config === undefined
		? Promise.reject(
				new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset"),
			)
		: Effect.runPromise(body(config));

const sourceTime = Timestamp.fromDate(new Date("2026-01-01T08:00:00.000Z"));

describe.skipIf(config === undefined)("family-scoped database", () => {
	test("a stored sample keeps source time, receive time, unit, provenance, and quality", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const family = yield* openFamilyDb(config);
					const { reducers } = family.connection;
					yield* Effect.promise(() =>
						reducers.createFamily({ name: "Rivera" }),
					);
					const [home] = readFamilyRecords(family).families;
					if (home === undefined) throw new Error("family was not created");
					yield* Effect.promise(() =>
						reducers.recordSample({
							familyId: BigInt(home.id),
							metric: "heart_rate",
							value: 61.5,
							unit: "bpm",
							sourceTime,
							source: "synthetic-demo",
							synthetic: true,
							quality: { tag: "Unvalidated" },
						}),
					);
					const [sample] = readFamilyRecords(family).samples;
					expect(sample).toMatchObject({
						familyId: home.id,
						metric: "heart_rate",
						value: 61.5,
						unit: "bpm",
						sourceTime: "2026-01-01T08:00:00.000000Z",
						source: "synthetic-demo",
						synthetic: true,
						quality: "unvalidated",
					});
					// The database sets the receive time itself, after the source time.
					expect(Date.parse(sample?.receivedAt ?? "")).toBeGreaterThan(
						Date.parse(sample?.sourceTime ?? ""),
					);
				}),
			),
		));

	test("another family's identity cannot read or write the family's records", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const owner = yield* openFamilyDb(config);
					const outsider = yield* openFamilyDb(config);
					expect(outsider.identity).not.toBe(owner.identity);

					const mine = owner.connection.reducers;
					yield* Effect.promise(() => mine.createFamily({ name: "Okafor" }));
					const [home] = readFamilyRecords(owner).families;
					if (home === undefined) throw new Error("family was not created");
					const familyId = BigInt(home.id);
					yield* Effect.promise(() =>
						mine.recordSample({
							familyId,
							metric: "spo2",
							value: 97,
							unit: "%",
							sourceTime,
							source: "synthetic-demo",
							synthetic: true,
							quality: { tag: "Validated" },
						}),
					);
					yield* Effect.promise(() =>
						mine.raiseAlert({
							familyId,
							sampleId: undefined,
							summary: "Check in",
						}),
					);
					yield* Effect.promise(() =>
						mine.sendMessage({ familyId, body: "On my way" }),
					);
					const before = readFamilyRecords(owner);
					const [alert] = before.alerts;
					if (alert === undefined) throw new Error("alert was not raised");

					// Reads: the outsider's views hold nothing of the owner's family.
					yield* Effect.promise(() =>
						outsider.connection.reducers.createFamily({ name: "Lindqvist" }),
					);
					const seen = readFamilyRecords(outsider);
					expect(seen.families.map((f) => f.name)).toEqual(["Lindqvist"]);
					expect(seen.samples).toEqual([]);
					expect(seen.alerts).toEqual([]);
					expect(seen.messages).toEqual([]);

					// Writes: every reducer that targets the owner's family rejects the outsider.
					const theirs = outsider.connection.reducers;
					const writes = [
						theirs.recordSample({
							familyId,
							metric: "spo2",
							value: 80,
							unit: "%",
							sourceTime,
							source: "synthetic-demo",
							synthetic: true,
							quality: { tag: "Validated" },
						}),
						theirs.raiseAlert({ familyId, sampleId: undefined, summary: "x" }),
						theirs.sendMessage({ familyId, body: "x" }),
						theirs.acknowledgeAlert({ alertId: BigInt(alert.id) }),
						theirs.addFamilyMember({
							familyId,
							member: Identity.fromString(outsider.identity),
						}),
					];
					const results = yield* Effect.promise(() =>
						Promise.allSettled(writes),
					);
					expect(
						results.map((r) =>
							r.status === "rejected" ? String(r.reason) : r.status,
						),
					).toEqual(
						writes.map(() => "SenderError: not a member of this family"),
					);

					expect(readFamilyRecords(owner)).toEqual(before);
				}),
			),
		));
});
