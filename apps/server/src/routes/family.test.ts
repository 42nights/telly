// Runs the family routes against a real local SpacetimeDB (see scripts/db-test.sh) and, for /ask, a
// local HTTP server that speaks the xAI Responses API shape. The model replies are scripted, so this
// proves record scoping, evidence, and error mapping, not a live xAI round trip.
import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, FamilyMessage } from "@health/contracts";
import { FamilyAnswer, FamilyMessages } from "@health/contracts/family";
import { Effect, Schema, type Scope } from "effect";
import { Hono } from "hono";
import { Timestamp } from "spacetimedb";
import {
	type DbConfig,
	type FamilyDb,
	openFamilyDb,
	readFamilyRecords,
} from "../db";
import { familyRoutes } from "./family";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const config: DbConfig | undefined =
	uri && database ? { uri, database } : undefined;

let replies: Array<unknown> = [];
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => Response.json(replies.shift() ?? {}),
});
afterAll(() => provider.stop(true));
const grokbot = {
	apiKey: "test-key",
	model: "grok-test",
	baseUrl: `http://127.0.0.1:${provider.port}`,
};

// Stands in for the API core's family middleware: it only sets the variables, without the
// membership check, so these tests show what the database itself refuses.
const app = (db: FamilyDb, familyId: string, withGrokbot = true) =>
	new Hono<{ Variables: { db: FamilyDb; familyId: string } }>()
		.use(async (c, next) => {
			c.set("db", db);
			c.set("familyId", familyId);
			await next();
		})
		.route("/", familyRoutes(withGrokbot ? grokbot : undefined));

const get = async (target: Pick<Hono, "request">, path: string) =>
	target.request(path);

const post = async (
	target: Pick<Hono, "request">,
	path: string,
	body: unknown,
) =>
	target.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const run = (
	body: (config: DbConfig) => Effect.Effect<void, unknown, Scope.Scope>,
) =>
	config === undefined
		? Promise.reject(
				new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset"),
			)
		: Effect.runPromise(Effect.scoped(body(config)));

const newFamily = (db: FamilyDb, name: string) =>
	Effect.promise(async () => {
		await db.connection.reducers.createFamily({ name });
		const family = readFamilyRecords(db).families.find((f) => f.name === name);
		if (family === undefined) throw new Error("family was not created");
		return family.id;
	});

const record = (
	db: FamilyDb,
	familyId: string,
	metric: string,
	value: number,
	at: string,
) =>
	Effect.promise(() =>
		db.connection.reducers.recordSample({
			familyId: BigInt(familyId),
			metric,
			value,
			unit: "h",
			sourceTime: Timestamp.fromDate(new Date(at)),
			source: "synthetic-demo",
			synthetic: true,
			quality: { tag: "Unvalidated" },
		}),
	);

const errorOf = async (response: Response) =>
	Schema.decodeUnknownSync(ApiError)(await response.json()).error;

describe.skipIf(config === undefined)("family routes", () => {
	test("a message persists once across resends and reconnects", () =>
		run((config) =>
			Effect.gen(function* () {
				const first = yield* openFamilyDb(config);
				const familyId = yield* newFamily(
					first,
					`Messages ${crypto.randomUUID()}`,
				);
				const send = {
					clientId: "phone-1",
					body: "Picked up her prescription",
				};

				const sent = yield* Effect.promise(() =>
					post(app(first, familyId), "/messages", send),
				);
				expect(sent.status).toBe(201);
				const stored = Schema.decodeUnknownSync(FamilyMessage)(
					yield* Effect.promise(() => sent.json()),
				);
				expect(stored).toMatchObject({
					familyId,
					sender: first.identity,
					...send,
				});

				// The phone lost the reply and resends from a new connection with the same identity.
				const again = yield* openFamilyDb({ ...config, token: first.token });
				const resent = yield* Effect.promise(() =>
					post(app(again, familyId), "/messages", send),
				);
				expect(resent.status).toBe(201);
				expect(yield* Effect.promise(() => resent.json())).toEqual(stored);

				const list = yield* Effect.promise(() =>
					get(app(again, familyId), "/messages"),
				);
				const { messages } = Schema.decodeUnknownSync(FamilyMessages)(
					yield* Effect.promise(() => list.json()),
				);
				expect(messages).toEqual([stored]);
				const later = yield* Effect.promise(() =>
					get(app(again, familyId), `/messages?after=${stored.id}`),
				);
				expect(yield* Effect.promise(() => later.json())).toEqual({
					messages: [],
				});

				const reused = yield* Effect.promise(() =>
					post(app(again, familyId), "/messages", {
						clientId: "phone-1",
						body: "Something else",
					}),
				);
				expect(reused.status).toBe(400);
				expect(yield* Effect.promise(() => errorOf(reused))).toBe(
					"invalid_request",
				);
			}),
		));

	test("invalid bodies and cursors are rejected before the database", () =>
		run((config) =>
			Effect.gen(function* () {
				const db = yield* openFamilyDb(config);
				const target = app(db, "1");
				for (const body of [
					{ clientId: "a b", body: "x" },
					{ clientId: "a", body: "   " },
					{ clientId: "a" },
					"x",
				]) {
					const response = yield* Effect.promise(() =>
						post(target, "/messages", body),
					);
					expect(response.status).toBe(400);
				}
				const cursor = yield* Effect.promise(() =>
					get(target, "/messages?after=-1"),
				);
				expect(cursor.status).toBe(400);
				const ask = yield* Effect.promise(() =>
					post(target, "/ask", { question: "hi", timeZone: "Mars/Base" }),
				);
				expect(ask.status).toBe(400);
			}),
		));

	test("another family's member can neither read nor post the family's messages", () =>
		run((config) =>
			Effect.gen(function* () {
				const owner = yield* openFamilyDb(config);
				const outsider = yield* openFamilyDb(config);
				const familyId = yield* newFamily(
					owner,
					`Owner ${crypto.randomUUID()}`,
				);
				yield* Effect.promise(() =>
					post(app(owner, familyId), "/messages", {
						clientId: "m1",
						body: "private",
					}),
				);

				const read = yield* Effect.promise(() =>
					get(app(outsider, familyId), "/messages"),
				);
				expect(yield* Effect.promise(() => read.json())).toEqual({
					messages: [],
				});
				const write = yield* Effect.promise(() =>
					post(app(outsider, familyId), "/messages", {
						clientId: "m2",
						body: "intrusion",
					}),
				);
				expect(write.status).toBe(403);
				expect(yield* Effect.promise(() => errorOf(write))).toBe("forbidden");
				expect(readFamilyRecords(owner).messages.map((m) => m.body)).toEqual([
					"private",
				]);
			}),
		));

	test("an answer cites only the family's own records and names missing ones", () =>
		run((config) =>
			Effect.gen(function* () {
				const owner = yield* openFamilyDb(config);
				const other = yield* openFamilyDb(config);
				const familyId = yield* newFamily(
					owner,
					`Sleep ${crypto.randomUUID()}`,
				);
				const otherId = yield* newFamily(other, `Other ${crypto.randomUUID()}`);
				yield* record(
					owner,
					familyId,
					"sleep_hours",
					6.7,
					"2026-01-01T07:00:00Z",
				);
				yield* record(
					other,
					otherId,
					"sleep_hours",
					3,
					new Date().toISOString(),
				);

				const done = { status: "completed", model: "grok-test" };
				replies = [
					{
						...done,
						output: [
							{
								type: "function_call",
								call_id: "a",
								name: "read_health_samples",
								arguments: '{"metric":"sleep_hours"}',
							},
							{
								type: "function_call",
								call_id: "b",
								name: "read_health_samples",
								arguments: '{"metric":"breathing_rate"}',
							},
						],
					},
					{
						...done,
						output: [
							{
								type: "message",
								content: [
									{ type: "output_text", text: "6.7 h on Jan 1 (synthetic)." },
								],
							},
						],
					},
				];
				const response = yield* Effect.promise(() =>
					post(app(owner, familyId), "/ask", {
						question: "How is Mom sleeping?",
						timeZone: "America/New_York",
					}),
				);
				expect(response.status).toBe(200);
				const answer = Schema.decodeUnknownSync(FamilyAnswer)(
					yield* Effect.promise(() => response.json()),
				);
				expect(answer.answer).toBe("6.7 h on Jan 1 (synthetic).");
				expect(answer.evidence).toHaveLength(1);
				expect(answer.evidence[0]).toMatchObject({
					familyId,
					value: 6.7,
					source: "synthetic-demo",
					synthetic: true,
					stale: true,
				});
				expect(answer.unavailable).toEqual(["breathing_rate"]);
			}),
		));

	test("an unconfigured or failing provider is reported, never answered", () =>
		run((config) =>
			Effect.gen(function* () {
				const db = yield* openFamilyDb(config);
				const familyId = yield* newFamily(db, `Errors ${crypto.randomUUID()}`);
				const unconfigured = yield* Effect.promise(() =>
					post(app(db, familyId, false), "/ask", { question: "hi" }),
				);
				expect(unconfigured.status).toBe(503);
				expect(yield* Effect.promise(() => errorOf(unconfigured))).toBe(
					"unavailable",
				);

				replies = [{ unexpected: true }];
				const broken = yield* Effect.promise(() =>
					post(app(db, familyId), "/ask", { question: "hi" }),
				);
				expect(broken.status).toBe(502);
				expect(yield* Effect.promise(() => errorOf(broken))).toBe(
					"upstream_error",
				);
			}),
		));
});
