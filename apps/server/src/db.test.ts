// Runs against a real local SpacetimeDB with the module published: `bun run db:test` starts an
// isolated in-memory database, publishes, sets SPACETIMEDB_URI and SPACETIMEDB_DATABASE, and runs
// this file. Each connection below is a separate identity issued by that database.
import { describe, expect, spyOn, test } from "bun:test";
import { CareScope } from "@health/contracts/care-profile";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { Identity, Timestamp } from "spacetimedb";
import {
	callDb,
	type DbConfig,
	DbRejected,
	DbUnavailable,
	openFamilyDb,
	readFamilyRecords,
} from "./db";
import { closed, dbProxy } from "./db-proxy";

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
						mine.sendMessage({ familyId, clientId: "m1", body: "On my way" }),
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
						theirs.sendMessage({ familyId, clientId: "m1", body: "x" }),
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
					// Through `callDb`, a refusal is `DbRejected`, distinct from an outage.
					const refused = yield* Effect.flip(
						callDb(outsider, (c) =>
							c.reducers.sendMessage({ familyId, clientId: "m2", body: "x" }),
						),
					);
					expect(refused).toEqual(
						new DbRejected({ reason: "not a member of this family" }),
					);

					expect(readFamilyRecords(owner)).toEqual(before);
				}),
			),
		));

	test("a new family's founder holds every care scope, a later member none, and only the operator runs the backfill", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const token = process.env.SPACETIMEDB_OPERATOR_TOKEN;
					if (token === undefined)
						throw new Error("db:test passes SPACETIMEDB_OPERATOR_TOKEN");
					const owner = yield* openFamilyDb(config);
					const relative = yield* openFamilyDb(config);
					const operator = yield* openFamilyDb({ ...config, token });
					const mine = owner.connection.reducers;
					yield* Effect.promise(() => mine.createFamily({ name: "Nakamura" }));
					const [home] = readFamilyRecords(owner).families;
					if (home === undefined) throw new Error("family was not created");
					const familyId = BigInt(home.id);
					yield* Effect.promise(() =>
						mine.addFamilyMember({
							familyId,
							member: Identity.fromString(relative.identity),
						}),
					);
					const grants = () =>
						[...owner.connection.db.myCareGrants.iter()]
							.filter((g) => g.familyId === familyId)
							.map((g) => [g.member.toHexString(), g.scope, g.granted])
							.sort();
					const founder = CareScope.literals
						.map((scope) => [owner.identity, scope, true])
						.sort();
					expect(grants()).toEqual(founder);

					const refused = yield* Effect.promise(() =>
						mine.backfillFounderCareGrants({}).then(String, String),
					);
					expect(refused).toBe("SenderError: not the delivery operator");
					// A family that has grant events is left as it is.
					yield* Effect.promise(() =>
						operator.connection.reducers.backfillFounderCareGrants({}),
					);
					// The owner's own call after the backfill sees every earlier commit.
					yield* Effect.promise(() =>
						mine.sendMessage({ familyId, clientId: "sync", body: "Synced" }),
					);
					expect(grants()).toEqual(founder);
				}),
			),
		));

	test("a dropped connection fails as unavailable, serves no stale rows, and a new connection sees every committed row", () =>
		run((config) =>
			Effect.gen(function* () {
				const link = yield* Effect.promise(() => dbProxy(config.uri));
				const viaProxy = { ...config, uri: link.uri };
				const token = yield* Effect.scoped(
					Effect.gen(function* () {
						const family = yield* openFamilyDb(viaProxy);
						yield* callDb(family, (c) =>
							c.reducers.createFamily({ name: "Haddad" }),
						);
						expect(readFamilyRecords(family).families).toHaveLength(1);

						// The call is sent, then the network drops before any reply can arrive.
						const inFlight = yield* Effect.flip(
							callDb(family, (c) => {
								const pending = c.reducers.createFamily({ name: "Lost" });
								link.drop();
								return pending;
							}),
						);
						expect(inFlight).toEqual(
							new DbUnavailable({ reason: "connection dropped" }),
						);
						expect(() => readFamilyRecords(family)).toThrow(DbUnavailable);
						const after = yield* Effect.flip(
							callDb(family, (c) => c.reducers.createFamily({ name: "Later" })),
						);
						expect(after).toEqual(
							new DbUnavailable({ reason: "connection closed" }),
						);
						return family.token;
					}),
				);

				// Recovery is a new connection as the same identity; the committed row is intact.
				yield* Effect.scoped(
					Effect.gen(function* () {
						const family = yield* openFamilyDb({ ...viaProxy, token });
						const names = readFamilyRecords(family)
							.families.map((f) => f.name)
							.filter((name) => name !== "Lost");
						expect(names).toEqual(["Haddad"]);
					}),
				);
				link.close();
			}),
		));

	// Without a token the first socket is the WebSocket; with one, it is the SDK's token fetch.
	test.each([
		["the WebSocket handshake", {}],
		["the token fetch", { token: "unchecked" }],
	])("an interrupted open closes its socket during %s", async (_, token) => {
		if (config === undefined) throw new Error("no database configured");
		const hung = await dbProxy(config.uri);
		hung.setMode("freeze");
		const accepted = hung.nextSocket();
		const abort = new AbortController();
		const opening = Effect.runPromise(
			Effect.scoped(openFamilyDb({ ...config, ...token, uri: hung.uri })),
			{ signal: abort.signal },
		);
		const released = closed(await accepted);
		abort.abort();
		await expect(opening).rejects.toThrow();
		// A leaked socket never closes, and the test times out here.
		await released;
		hung.close();
	});

	test("an unreachable database fails as unavailable after bounded retries", async () => {
		if (config === undefined) throw new Error("no database configured");
		const down = await dbProxy(config.uri);
		down.setMode("refuse");
		const started = Date.now();
		const error = await Effect.runPromise(
			Effect.flip(Effect.scoped(openFamilyDb({ ...config, uri: down.uri }))),
		);
		expect(error).toEqual(new DbUnavailable({ reason: "connect failed" }));
		// Three attempts with 250 ms and 500 ms backoff, far below the 5 s per-attempt timeout.
		expect(Date.now() - started).toBeLessThan(3000);
		down.close();
	});

	test("a database that never answers an open fails as unavailable after three timed-out attempts", async () => {
		if (config === undefined) throw new Error("no database configured");
		const hung = await dbProxy(config.uri);
		hung.setMode("freeze");
		try {
			const error = await Effect.runPromise(
				Effect.gen(function* () {
					const opening = yield* Effect.forkChild(
						Effect.flip(
							Effect.scoped(openFamilyDb({ ...config, uri: hung.uri })),
						),
					);
					// Three 5 s attempts with 250 ms and 500 ms backoff: about 15.75 s of database silence.
					let waited = 0;
					while (opening.pollUnsafe() === undefined && waited < 60_000) {
						yield* TestClock.adjust("250 millis");
						waited += 250;
						yield* Effect.yieldNow;
					}
					expect(opening.pollUnsafe()).toBeDefined();
					expect(waited).toBeGreaterThanOrEqual(15_750);
					return yield* Fiber.join(opening);
				}).pipe(Effect.provide(TestClock.layer())),
			);
			expect(error).toEqual(new DbUnavailable({ reason: "connect timed out" }));
		} finally {
			hung.close();
		}
	});

	test("a refused subscription fails the open at once as unavailable and closes its socket", async () => {
		if (config === undefined) throw new Error("no database configured");
		const link = await dbProxy(config.uri);
		// As a module without the server's views would: the database refuses the subscription.
		const builder = await Effect.runPromise(
			Effect.scoped(
				Effect.map(openFamilyDb(config), ({ connection }) =>
					Object.getPrototypeOf(connection.subscriptionBuilder()),
				),
			),
		);
		const subscribe = builder.subscribe;
		const refused = spyOn(builder, "subscribe").mockImplementation(function (
			this: unknown,
		) {
			return subscribe.call(this, ["SELECT * FROM no_such_view"]);
		});
		try {
			const accepted = link.nextSocket();
			const started = Date.now();
			const error = await Effect.runPromise(
				Effect.flip(Effect.scoped(openFamilyDb({ ...config, uri: link.uri }))),
			);
			expect(error).toEqual(
				new DbUnavailable({ reason: "subscription failed" }),
			);
			expect(refused).toHaveBeenCalledTimes(3);
			// Far below one 5 s connect timeout: the refusal is not waited out.
			expect(Date.now() - started).toBeLessThan(3000);
			await closed(await accepted);
		} finally {
			refused.mockRestore();
			link.close();
		}
	});

	test("a call the database never answers fails as unavailable after 5 s", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const family = yield* openFamilyDb(config);
					// The SDK never settles a call the database does not answer.
					const call = yield* Effect.forkChild(
						Effect.flip(callDb(family, () => new Promise<never>(() => {}))),
					);
					yield* Effect.yieldNow;
					yield* TestClock.adjust("4999 millis");
					expect(call.pollUnsafe()).toBeUndefined();
					yield* TestClock.adjust("1 millis");
					expect(yield* Fiber.join(call)).toEqual(
						new DbUnavailable({ reason: "call timed out" }),
					);
					// A timed-out call leaves the connection usable.
					yield* callDb(family, (c) =>
						c.reducers.createFamily({ name: "After timeout" }),
					);
				}),
			).pipe(Effect.provide(TestClock.layer())),
		));
});
