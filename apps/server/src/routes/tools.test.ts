// Runs the real app (sign-in, membership check, tool route) against a real local SpacetimeDB:
// `bun run db:test` starts it and sets SPACETIMEDB_URI and SPACETIMEDB_DATABASE. The OIDC issuer
// is a test-only server on 127.0.0.1 with a key made for this run.
import { afterAll, describe, expect, test } from "bun:test";
import { Family } from "@health/contracts";
import { Me } from "@health/contracts/families";
import { Effect, Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "../app";
import { openFamilyDb } from "../db";
import { delegate } from "../delegation";
import { DELEGATION_HEADER } from "./tools";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;

const { publicKey, privateKey } = await crypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["sign", "verify"],
);
const jwk = async (key: CryptoKey) => ({
	...(await crypto.subtle.exportKey("jwk", key)),
	kid: "tools-test",
	alg: "RS256",
});
const keys = { keys: [await jwk(publicKey)] };
const signingKey = await jwk(privateKey);
const issuerServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request): Response =>
		new URL(request.url).pathname === "/jwks"
			? Response.json(keys)
			: Response.json({ issuer, jwks_uri: `${issuer}/jwks` }),
});
const issuer = `http://127.0.0.1:${issuerServer.port}`;
afterAll(() => issuerServer.stop(true));

const tokenFor = (subject: string) =>
	sign(
		{
			iss: issuer,
			aud: "telly-test",
			sub: subject,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 600,
		},
		signingKey,
		"RS256",
	);

const app =
	uri && database
		? createApp({
				corsOrigin: "http://localhost:3001",
				auth: { issuer, audience: "telly-test", db: { uri, database } },
				voice: {
					apiKey: undefined,
					voiceId: "unused",
					baseUrl: "http://127.0.0.1:1",
				},
			})
		: undefined;

/** One request as `subject`; `null` sends no token. Returns the status and the JSON body. */
const send = async (
	subject: string | null,
	method: string,
	path: string,
	body?: unknown,
) => {
	if (app === undefined) throw new Error("no database");
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (subject !== null)
		headers.Authorization = `Bearer ${await tokenFor(subject)}`;
	const response = await app.request(path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return [response.status, await response.json().catch(() => null)] as const;
};

const sample = (sourceTime: string, metric = "heart_rate") => ({
	metric,
	value: 60,
	unit: "bpm",
	sourceTime,
	source: "synthetic-demo",
	synthetic: true,
	quality: "validated",
});

describe.skipIf(app === undefined)("agent tool route", () => {
	test("the worker gets only its granted family's records; everyone else is refused", async () => {
		const owner = `owner-${crypto.randomUUID()}`;
		const worker = `fetch-worker-${crypto.randomUUID()}`;
		const newFamily = async (name: string) =>
			Schema.decodeUnknownSync(Family)(
				(await send(owner, "POST", "/api/families", { name }))[1],
			);
		const home = await newFamily("Home");
		const other = await newFamily("Other");
		for (const [family, body] of [
			[home, sample("2026-01-01T08:00:00.000Z")],
			[home, sample("2026-01-01T09:00:00.000Z")],
			[home, sample("2026-01-01T10:00:00.000Z", "spo2")],
			[other, sample("2026-01-01T11:00:00.000Z")],
		] as const)
			await send(owner, "POST", `/api/families/${family.id}/samples`, body);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					if (uri === undefined || database === undefined) return;
					const db = yield* openFamilyDb({
						uri,
						database,
						token: yield* Effect.promise(() => tokenFor(owner)),
					});
					for (const family of [home, other])
						yield* Effect.promise(() =>
							db.connection.reducers.raiseAlert({
								familyId: BigInt(family.id),
								sampleId: undefined,
								summary: `Check in at ${family.name}`,
							}),
						);
				}),
			),
		);
		const workerMe = Schema.decodeUnknownSync(Me)(
			(await send(worker, "GET", "/api/me"))[1],
		);
		await send(owner, "POST", `/api/families/${home.id}/members`, {
			identity: workerMe.identity,
		});

		const tools = (family: Family) => `/api/families/${family.id}/tools`;
		expect(
			await send(worker, "POST", tools(home), {
				tool: "health_samples",
				input: { metric: "heart_rate", limit: 5 },
			}),
		).toMatchObject([
			200,
			{
				tool: "health_samples",
				samples: [
					{ familyId: home.id, sourceTime: "2026-01-01T09:00:00.000000Z" },
					{ familyId: home.id, sourceTime: "2026-01-01T08:00:00.000000Z" },
				],
			},
		]);
		expect(
			await send(worker, "POST", tools(home), { tool: "alerts", input: {} }),
		).toMatchObject([
			200,
			{
				tool: "alerts",
				alerts: [{ familyId: home.id, summary: "Check in at Home" }],
				acknowledgements: [],
			},
		]);

		const alerts = { tool: "alerts", input: {} };
		expect(await send(worker, "POST", tools(other), alerts)).toMatchObject([
			403,
			{ error: "forbidden" },
		]);
		expect(await send(null, "POST", tools(home), alerts)).toMatchObject([
			401,
			{ error: "unauthorized" },
		]);
		for (const body of [
			{ tool: "run_sql", input: { query: "SELECT *" } },
			{ tool: "alerts", input: { limit: 0 } },
			{ tool: "alerts", input: { limit: 101 } },
			{ tool: "alerts", input: {}, token: "forwarded" },
			"not an object",
		])
			expect(await send(worker, "POST", tools(home), body)).toMatchObject([
				400,
				{ error: "invalid_request" },
			]);
		// A body over 16 KiB is refused before any tool runs.
		expect(
			await send(worker, "POST", tools(home), {
				tool: "alerts",
				input: {},
				padding: "x".repeat(16 * 1024),
			}),
		).toMatchObject([
			400,
			{ error: "invalid_request", message: "Request body is too large" },
		]);
	});

	test("a delegation lends one family's records to a non-member worker until it is released", async () => {
		const owner = `owner-${crypto.randomUUID()}`;
		const worker = `fetch-worker-${crypto.randomUUID()}`;
		const newFamily = async (name: string) =>
			Schema.decodeUnknownSync(Family)(
				(await send(owner, "POST", "/api/families", { name }))[1],
			);
		const home = await newFamily("Home");
		const other = await newFamily("Other");
		await send(
			owner,
			"POST",
			`/api/families/${home.id}/samples`,
			sample("2026-01-01T08:00:00.000Z"),
		);
		const asWorker = async (family: Family, delegation?: string) => {
			if (app === undefined) throw new Error("no database");
			const response = await app.request(`/api/families/${family.id}/tools`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${await tokenFor(worker)}`,
					...(delegation === undefined
						? {}
						: { [DELEGATION_HEADER]: delegation }),
				},
				body: JSON.stringify({ tool: "health_samples", input: {} }),
			});
			return [response.status, await response.json()] as const;
		};
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					if (uri === undefined || database === undefined) return;
					const ownerDb = yield* openFamilyDb({
						uri,
						database,
						token: yield* Effect.promise(() => tokenFor(owner)),
					});
					const lent = delegate(ownerDb, BigInt(home.id));
					const [status, body] = yield* Effect.promise(() =>
						asWorker(home, lent.token),
					);
					expect([status, body]).toMatchObject([
						200,
						{
							tool: "health_samples",
							samples: [{ familyId: home.id }],
						},
					]);
					// The worker is not a member: no delegation, another family, or a guess is refused.
					for (const [family, delegation] of [
						[home, undefined],
						[other, lent.token],
						[home, "guess"],
					] as const)
						expect(
							yield* Effect.promise(() => asWorker(family, delegation)),
						).toMatchObject([403, { error: "forbidden" }]);
					lent.release();
					expect(
						yield* Effect.promise(() => asWorker(home, lent.token)),
					).toMatchObject([403, { error: "forbidden" }]);
				}),
			),
		);
	});
});
