// Runs against a real local SpacetimeDB: `bun run db:test` starts it and sets SPACETIMEDB_URI and
// SPACETIMEDB_DATABASE. The test-only middleware below stands in for the family middleware: it sets
// the caller's `db` and the path's `familyId`, which is all `toolRoutes` reads.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Hono } from "hono";
import { Timestamp } from "spacetimedb";
import {
	type DbConfig,
	type FamilyDb,
	openFamilyDb,
	readFamilyRecords,
} from "../db";
import { toolRoutes } from "./tools";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const config: DbConfig | undefined =
	uri && database ? { uri, database } : undefined;

/** POSTs a tool request as an identity whose database connection is `db`. */
const call = (db: FamilyDb, familyId: string, body: unknown) =>
	new Hono<{ Variables: { db: FamilyDb; familyId: string } }>()
		.use("/api/families/:familyId/*", async (c, next) => {
			c.set("db", db);
			c.set("familyId", c.req.param("familyId") ?? "");
			await next();
		})
		.route("/api/families/:familyId", toolRoutes())
		.request(`/api/families/${familyId}/tools`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

const at = (iso: string) => Timestamp.fromDate(new Date(iso));

describe.skipIf(config === undefined)("agent tool routes", () => {
	test("a tool returns only the requested family's records, newest first", () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					if (config === undefined) throw new Error("no database");
					const db = yield* openFamilyDb(config);
					const { reducers } = db.connection;
					yield* Effect.promise(() => reducers.createFamily({ name: "Home" }));
					yield* Effect.promise(() => reducers.createFamily({ name: "Other" }));
					const [home, other] = readFamilyRecords(db).families;
					if (home === undefined || other === undefined)
						throw new Error("families were not created");
					const sample = (familyId: string, metric: string, time: string) =>
						reducers.recordSample({
							familyId: BigInt(familyId),
							metric,
							value: 60,
							unit: "bpm",
							sourceTime: at(time),
							source: "synthetic-demo",
							synthetic: true,
							quality: { tag: "Validated" },
						});
					yield* Effect.promise(async () => {
						await sample(home.id, "heart_rate", "2026-01-01T08:00:00Z");
						await sample(home.id, "heart_rate", "2026-01-01T09:00:00Z");
						await sample(home.id, "spo2", "2026-01-01T10:00:00Z");
						await sample(other.id, "heart_rate", "2026-01-01T11:00:00Z");
						await reducers.raiseAlert({
							familyId: BigInt(home.id),
							sampleId: undefined,
							summary: "Check in",
						});
						await reducers.raiseAlert({
							familyId: BigInt(other.id),
							sampleId: undefined,
							summary: "Elsewhere",
						});
					});
					const [otherAlert] = readFamilyRecords(db).alerts.filter(
						(alert) => alert.familyId === other.id,
					);
					if (otherAlert === undefined) throw new Error("alert was not raised");
					yield* Effect.promise(() =>
						reducers.acknowledgeAlert({ alertId: BigInt(otherAlert.id) }),
					);

					const samples = yield* Effect.promise(async () =>
						(
							await call(db, home.id, {
								tool: "health_samples",
								input: { metric: "heart_rate", limit: 5 },
							})
						).json(),
					);
					expect(samples).toMatchObject({
						tool: "health_samples",
						samples: [
							{ familyId: home.id, sourceTime: "2026-01-01T09:00:00.000000Z" },
							{ familyId: home.id, sourceTime: "2026-01-01T08:00:00.000000Z" },
						],
					});

					const alerts = yield* Effect.promise(async () =>
						(await call(db, home.id, { tool: "alerts", input: {} })).json(),
					);
					expect(alerts).toMatchObject({
						tool: "alerts",
						alerts: [{ familyId: home.id, summary: "Check in" }],
						acknowledgements: [],
					});
				}),
			),
		));
});

test("an unsupported or malformed tool request is rejected before any read", async () => {
	// No database at all: any read would throw, so a 400 proves validation ran first.
	const noDatabase = undefined as unknown as FamilyDb;
	for (const body of [
		{ tool: "run_sql", input: { query: "SELECT *" } },
		{ tool: "alerts", input: { limit: 0 } },
		{ tool: "alerts", input: { limit: 101 } },
		{ tool: "alerts", input: {}, token: "forwarded" },
		"not an object",
	]) {
		const response = await call(noDatabase, "1", body);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "invalid_request" });
	}
});
