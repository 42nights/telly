// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). The OIDC issuer
// below is a test-only server on 127.0.0.1 with a key made for this run; SpacetimeDB fetches its keys
// to verify the same tokens. Passing here is not proof of sign-in with the production provider.
import { afterAll, describe, expect, test } from "bun:test";
import {
	ApiError,
	Family,
	FamilyRecords,
	HealthSample,
} from "@health/contracts";
import { Me } from "@health/contracts/families";
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
