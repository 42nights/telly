// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). The OIDC issuer
// below is a test-only server on 127.0.0.1 with a key made for this run; SpacetimeDB fetches its keys
// to verify the same tokens. Passing here is not proof of sign-in with the production provider.
import { afterAll, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
	ApiError,
	Family,
	FamilyRecords,
	HealthSample,
} from "@health/contracts";
import {
	FamilyInvite,
	JoinedFamily,
	Me,
	WhoopPushToken,
} from "@health/contracts/families";
import { Effect, Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "./app";
import { openFamilyDb, pushTokenFamily } from "./db";
import { sha256Hex } from "./http";
import { noopIngest } from "./integrations/noop-ingest";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
// Voice is not configured here; voice routes have their own tests.
const noVoice = {
	apiKey: undefined,
	voiceId: "unused",
	baseUrl: "http://127.0.0.1:1",
};
const audience = "telly-test";

const rsaKey = async (kid: string) => {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	return {
		public: {
			...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
			kid,
			alg: "RS256",
		},
		private: {
			...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
			kid,
			alg: "RS256",
		},
	};
};

const trusted = await rsaKey("test-key");
// Same `kid`, different key: a forged signature.
const forger = await rsaKey("test-key");

const issuerServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request): Response => {
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/openid-configuration")
			return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
		if (pathname === "/jwks") return Response.json({ keys: [trusted.public] });
		return new Response(null, { status: 404 });
	},
});
const issuer = `http://127.0.0.1:${issuerServer.port}`;
afterAll(() => issuerServer.stop(true));

const now = () => Math.floor(Date.now() / 1000);
const token = (
	subject: string,
	claims: Record<string, unknown> = {},
	key = trusted.private,
) =>
	sign(
		{
			iss: issuer,
			sub: subject,
			aud: audience,
			iat: now(),
			exp: now() + 600,
			...claims,
		},
		key,
		"RS256",
	);

const app =
	uri && database
		? createApp({
				corsOrigin: "http://localhost:3001",
				auth: { issuer, audience, db: { uri, database } },
				voice: noVoice,
			})
		: undefined;

const call = async (
	subject: string,
	method: string,
	path: string,
	body?: unknown,
	target = app,
) => {
	if (target === undefined)
		throw new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset");
	return target.request(path, {
		method,
		headers: {
			Authorization: `Bearer ${await token(subject)}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
};

const errorOf = async (response: Response) =>
	[
		response.status,
		Schema.decodeUnknownSync(ApiError)(await response.json()).error,
	] as const;

const sample = {
	metric: "heart_rate",
	value: 61.5,
	unit: "bpm",
	sourceTime: "2026-01-01T08:00:00.000Z",
	source: "synthetic-demo",
	synthetic: true,
	quality: "unvalidated",
};

describe.skipIf(app === undefined)("sign-in and family access", () => {
	test("requests without a valid token are refused with 401", async () => {
		const tokens = [
			undefined,
			"not-a-jwt",
			await token("alice", { aud: "another-api" }),
			await token("alice", { iss: "http://127.0.0.1:1" }),
			await token("alice", { exp: now() - 60 }),
			await token("alice", { exp: undefined }),
			await token("alice", { sub: "" }),
			await token("alice", {}, forger.private),
		];
		for (const bearer of tokens) {
			const response = await app?.request("/api/families", {
				headers:
					bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` },
			});
			if (response === undefined) throw new Error("no app");
			expect(await errorOf(response)).toEqual([401, "unauthorized"]);
		}
	});

	test("a valid token with an unreachable database is unavailable, never anonymous", async () => {
		const offline = createApp({
			corsOrigin: "http://localhost:3001",
			auth: {
				issuer,
				audience,
				db: { uri: "ws://127.0.0.1:1", database: "health-test" },
			},
			voice: noVoice,
		});
		const response = await offline.request("/api/families", {
			headers: { Authorization: `Bearer ${await token("alice")}` },
		});
		expect(await errorOf(response)).toEqual([503, "unavailable"]);
	});

	test("members read and write their family; other people are refused", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const bob = `bob-${crypto.randomUUID()}`;

		const created = await call(alice, "POST", "/api/families", {
			name: "Rivera",
		});
		expect(created.status).toBe(201);
		const family = Schema.decodeUnknownSync(Family)(await created.json());
		const path = `/api/families/${family.id}`;

		const recorded = await call(alice, "POST", `${path}/samples`, sample);
		expect(recorded.status).toBe(201);
		expect(
			Schema.decodeUnknownSync(HealthSample)(await recorded.json()),
		).toMatchObject({
			familyId: family.id,
			metric: "heart_rate",
			synthetic: true,
			quality: "unvalidated",
		});

		// Bob is signed in but not a member: no reads, no writes, not even adding himself.
		const bobMe = Schema.decodeUnknownSync(Me)(
			await (await call(bob, "GET", "/api/me")).json(),
		);
		expect(await errorOf(await call(bob, "GET", path))).toEqual([
			403,
			"forbidden",
		]);
		expect(
			await errorOf(await call(bob, "POST", `${path}/samples`, sample)),
		).toEqual([403, "forbidden"]);
		expect(
			await errorOf(
				await call(bob, "POST", `${path}/members`, {
					identity: bobMe.identity,
				}),
			),
		).toEqual([403, "forbidden"]);
		const bobFamilies = await (await call(bob, "GET", "/api/families")).json();
		expect(bobFamilies).toEqual({ families: [] });

		// Alice adds Bob by his identity; now the database lets him read the family.
		expect(
			(
				await call(alice, "POST", `${path}/members`, {
					identity: bobMe.identity,
				})
			).status,
		).toBe(204);
		const read = await call(bob, "GET", path);
		expect(read.status).toBe(200);
		const records = Schema.decodeUnknownSync(FamilyRecords)(await read.json());
		expect(records.families.map((f) => f.id)).toEqual([family.id]);
		expect(records.samples.map((s) => s.source)).toEqual(["synthetic-demo"]);
	});

	test("a write cannot carry fields outside its contract", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const created = await call(alice, "POST", "/api/families", {
			name: "Okafor",
		});
		const family = Schema.decodeUnknownSync(Family)(await created.json());
		const smuggled = {
			...sample,
			familyId: "999",
			receivedAt: sample.sourceTime,
		};
		expect(
			await errorOf(
				await call(
					alice,
					"POST",
					`/api/families/${family.id}/samples`,
					smuggled,
				),
			),
		).toEqual([400, "invalid_request"]);
	});

	test("/api/me shows the token's profile claims, and null for each one it lacks", async () => {
		const me = async (claims: Record<string, unknown>) => {
			const bearer = await token(`me-${crypto.randomUUID()}`, claims);
			const response = await app?.request("/api/me", {
				headers: { Authorization: `Bearer ${bearer}` },
			});
			return Schema.decodeUnknownSync(Me)(await response?.json());
		};
		expect(
			await me({
				name: "Synthetic Ana Rivera",
				given_name: "Synthetic Ana",
				email: "ana@example.test",
				picture: "https://example.test/ana.png",
			}),
		).toMatchObject({
			name: "Synthetic Ana Rivera",
			givenName: "Synthetic Ana",
			email: "ana@example.test",
			picture: "https://example.test/ana.png",
		});
		expect(await me({})).toMatchObject({
			name: null,
			givenName: null,
			email: null,
			picture: null,
		});
	});

	test("an invite admits one person once; members may reuse the link", async () => {
		const [alice, bob, carol] = ["alice", "bob", "carol"].map(
			(name) => `${name}-${crypto.randomUUID()}`,
		) as [string, string, string];
		const family = Schema.decodeUnknownSync(Family)(
			await (
				await call(alice, "POST", "/api/families", { name: "Ito" })
			).json(),
		);
		const path = `/api/families/${family.id}`;
		expect(await errorOf(await call(bob, "POST", `${path}/invites`))).toEqual([
			403,
			"forbidden",
		]);

		const created = await call(alice, "POST", `${path}/invites`);
		expect(created.status).toBe(201);
		const invite = Schema.decodeUnknownSync(FamilyInvite)(await created.json());
		expect(invite.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const days = (Date.parse(invite.expiresAt) - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.99);
		expect(days).toBeLessThanOrEqual(7);

		const join = (subject: string, code: string) =>
			call(subject, "POST", `/api/invites/${encodeURIComponent(code)}/join`);
		const joined = async (subject: string, code: string) => {
			const response = await join(subject, code);
			expect(response.status).toBe(200);
			return Schema.decodeUnknownSync(JoinedFamily)(await response.json())
				.family;
		};
		// A member's join does not use the invite up.
		expect(await joined(alice, invite.code)).toEqual(family);
		expect(await joined(bob, invite.code)).toEqual(family);
		expect(await joined(bob, invite.code)).toEqual(family);
		expect(await errorOf(await join(carol, invite.code))).toEqual([
			400,
			"invalid_request",
		]);
		expect(await errorOf(await join(carol, "not-a-code"))).toEqual([
			400,
			"invalid_request",
		]);
		expect((await call(bob, "GET", path)).status).toBe(200);
		expect((await call(carol, "GET", path)).status).toBe(403);
	});

	test("a family's WHOOP push token records NOOP batches into that family only", () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					if (!(uri && database)) throw new Error("no database");
					const auth = { issuer, audience, db: { uri, database } };
					const ingest = yield* openFamilyDb({ uri, database });
					const pushApp = createApp(
						{ corsOrigin: "http://localhost:3001", auth, voice: noVoice },
						noopIngest(ingest),
					);
					const as = (subject: string, method: string, path: string) =>
						Effect.promise(() =>
							call(subject, method, path, undefined, pushApp),
						);
					const alice = `alice-${crypto.randomUUID()}`;
					const bob = `bob-${crypto.randomUUID()}`;
					const family = Schema.decodeUnknownSync(Family)(
						yield* Effect.promise(async () =>
							(
								await call(alice, "POST", "/api/families", { name: "Moreau" })
							).json(),
						),
					);
					const path = `/api/families/${family.id}`;
					const bobMe = Schema.decodeUnknownSync(Me)(
						yield* Effect.promise(async () =>
							(await call(bob, "GET", "/api/me")).json(),
						),
					);
					yield* Effect.promise(() =>
						call(alice, "POST", `${path}/members`, {
							identity: bobMe.identity,
						}),
					);

					// Without NOOP ingest the route is unavailable; a member without sharing rights is refused.
					const noIngest = yield* Effect.promise(() =>
						call(alice, "POST", `${path}/whoop-token`),
					);
					expect(yield* Effect.promise(() => errorOf(noIngest))).toEqual([
						503,
						"unavailable",
					]);
					const refused = yield* as(bob, "POST", `${path}/whoop-token`);
					expect(yield* Effect.promise(() => errorOf(refused))).toEqual([
						403,
						"forbidden",
					]);

					const newToken = Effect.gen(function* () {
						const response = yield* as(alice, "POST", `${path}/whoop-token`);
						expect(response.status).toBe(201);
						const { token } = Schema.decodeUnknownSync(WhoopPushToken)(
							yield* Effect.promise(() => response.json()),
						);
						// The ingest identity's view updates asynchronously.
						for (let tries = 0; tries < 100; tries++) {
							if (pushTokenFamily(ingest, sha256Hex(token)) !== undefined)
								break;
							yield* Effect.sleep("20 millis");
						}
						return token;
					});
					const push = (key: string) =>
						Effect.promise(async () =>
							pushApp.request(`/api/noop/ingest?k=${encodeURIComponent(key)}`, {
								method: "POST",
								body: deflateRawSync(
									JSON.stringify({
										tables: {
											hrSample: [
												{
													deviceId: "test-whoop",
													ts: Math.floor(Date.now() / 1000) - 60,
													bpm: 61,
												},
											],
										},
									}),
								),
							}),
						);

					const first = yield* newToken;
					expect(pushTokenFamily(ingest, sha256Hex(first))).toBe(
						BigInt(family.id),
					);
					expect((yield* push(first)).status).toBe(200);
					expect((yield* push("unknown-token")).status).toBe(401);
					let samples: readonly HealthSample[] = [];
					for (let tries = 0; samples.length === 0 && tries < 100; tries++) {
						const read = yield* as(alice, "GET", path);
						samples = Schema.decodeUnknownSync(FamilyRecords)(
							yield* Effect.promise(() => read.json()),
						).samples;
						if (samples.length === 0) yield* Effect.sleep("20 millis");
					}
					expect(samples).toMatchObject([
						{
							familyId: family.id,
							metric: "heart_rate",
							source: "noop:test-whoop",
							synthetic: false,
							quality: "unvalidated",
						},
					]);

					// A new token revokes the old one.
					const second = yield* newToken;
					expect(pushTokenFamily(ingest, sha256Hex(first))).toBeUndefined();
					expect((yield* push(first)).status).toBe(401);
					expect((yield* push(second)).status).toBe(200);
				}),
			),
		));
});
