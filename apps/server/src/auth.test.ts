// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). The OIDC issuer
// below is a test-only server on 127.0.0.1 with a key made for this run; SpacetimeDB fetches its keys
// to verify the same tokens. Passing here is not proof of sign-in with the production provider.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
	ApiError,
	Family,
	FamilyRecords,
	HealthSample,
} from "@health/contracts";
import { Me } from "@health/contracts/families";
import { DbConnection } from "@health/db";
import { Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "./app";

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
) => {
	if (app === undefined)
		throw new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset");
	return app.request(path, {
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

	test("an unreachable sign-in provider is unavailable, and sign-in works again once it is back", async () => {
		let up = false;
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request): Response => {
				if (!up) return new Response(null, { status: 500 });
				const { pathname } = new URL(request.url);
				return pathname === "/jwks"
					? Response.json({ keys: [trusted.public] })
					: Response.json({ issuer: flaky, jwks_uri: `${flaky}/jwks` });
			},
		});
		const flaky = `http://127.0.0.1:${provider.port}`;
		// The database is unreachable, so a token that passes the sign-in check answers its 503.
		const offline = createApp({
			corsOrigin: "http://localhost:3001",
			auth: {
				issuer: flaky,
				audience,
				db: { uri: "ws://127.0.0.1:1", database: "health-test" },
			},
			voice: noVoice,
		});
		const request = async () =>
			offline.request("/api/families", {
				headers: {
					Authorization: `Bearer ${await token("alice", { iss: flaky })}`,
				},
			});
		try {
			const down = await request();
			expect([down.status, await down.json()]).toEqual([
				503,
				{
					error: "unavailable",
					message: "The sign-in provider is not reachable",
				},
			]);
			up = true;
			const back = await request();
			expect([back.status, await back.json()]).toEqual([
				503,
				{ error: "unavailable", message: "The database is not reachable" },
			]);
		} finally {
			provider.stop(true);
		}
	});

	test("a rotated key is fetched at most once a minute, and keys are fetched again after ten minutes", async () => {
		const rotated = await rsaKey("rotated-key");
		let published = [trusted.public];
		let keyFetches = 0;
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request): Response => {
				if (new URL(request.url).pathname !== "/jwks")
					return Response.json({
						issuer: rotating,
						jwks_uri: `${rotating}/jwks`,
					});
				keyFetches++;
				return Response.json({ keys: published });
			},
		});
		const rotating = `http://127.0.0.1:${provider.port}`;
		// The database is unreachable: 503 means the token passed the sign-in check, 401 that it did not.
		const offline = createApp({
			corsOrigin: "http://localhost:3001",
			auth: {
				issuer: rotating,
				audience,
				db: { uri: "ws://127.0.0.1:1", database: "health-test" },
			},
			voice: noVoice,
		});
		const claims = { iss: rotating, exp: now() + 3600 };
		const oldKey = await token("alice", claims);
		const newKey = await token("alice", claims, rotated.private);
		const status = async (bearer: string) =>
			(
				await offline.request("/api/families", {
					headers: { Authorization: `Bearer ${bearer}` },
				})
			).status;
		const start = Date.now();
		const clock = spyOn(Date, "now");
		try {
			clock.mockReturnValue(start);
			expect(await status(oldKey)).toBe(503);
			expect(keyFetches).toBe(1);

			// The provider rotates. Within a minute an unknown key id does not refetch the keys.
			published = [rotated.public];
			expect(await status(newKey)).toBe(401);
			expect(keyFetches).toBe(1);

			clock.mockReturnValue(start + 61_000);
			expect(await status(newKey)).toBe(503);
			expect(keyFetches).toBe(2);
			// The retired key is gone from the fresh keys.
			expect(await status(oldKey)).toBe(401);
			expect(keyFetches).toBe(2);

			// A known key id still refetches once the keys are ten minutes old: a revoked key stops working.
			published = [];
			clock.mockReturnValue(start + 61_000 + 10 * 60_000 + 1);
			expect(await status(newKey)).toBe(401);
			expect(keyFetches).toBe(3);
		} finally {
			clock.mockRestore();
			provider.stop(true);
		}
	});

	test("a database that answers with another token is refused, never run as that identity", async () => {
		// As if the database issued a new anonymous identity instead of accepting the caller's token.
		const builder = Object.getPrototypeOf(
			Object.getPrototypeOf(DbConnection.builder()),
		);
		const onConnect = builder.onConnect;
		const anonymous = spyOn(builder, "onConnect").mockImplementation(function (
			this: unknown,
			callback: (connection: unknown, identity: unknown, token: string) => void,
		) {
			return onConnect.call(this, (connection: unknown, identity: unknown) =>
				callback(connection, identity, "issued-anonymous-token"),
			);
		});
		try {
			const response = await call(
				`alice-${crypto.randomUUID()}`,
				"GET",
				"/api/families",
			);
			expect([response.status, await response.json()]).toEqual([
				401,
				{
					error: "unauthorized",
					message: "The database did not accept the sign-in token",
				},
			]);
			expect(anonymous).toHaveBeenCalled();
		} finally {
			anonymous.mockRestore();
		}
	});

	test("a family id that is not a u64 database id is invalid; the largest one is only forbidden", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		for (const familyId of ["abc", "01", "-1", "18446744073709551616", "1e3"])
			expect(
				await errorOf(await call(alice, "GET", `/api/families/${familyId}`)),
			).toEqual([400, "invalid_request"]);
		expect(
			await errorOf(
				await call(alice, "GET", "/api/families/18446744073709551615"),
			),
		).toEqual([403, "forbidden"]);
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
});
