// Runs the mounted chat routes in the real app against a real local SpacetimeDB (`bun run db:test`).
// The OIDC issuer is a test-only server on 127.0.0.1 with a key made for this run.
import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, Family, FamilyMessage } from "@health/contracts";
import { FamilyMessages } from "@health/contracts/chat";
import { Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "../app";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const audience = "telly-test";

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
const jwk = { kid: "chat-test", alg: "RS256" };
const publicKey = {
	...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
	...jwk,
};
const privateKey = {
	...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
	...jwk,
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request): Response => {
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/openid-configuration")
			return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
		if (pathname === "/jwks") return Response.json({ keys: [publicKey] });
		return new Response(null, { status: 404 });
	},
});
const issuer = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

const now = () => Math.floor(Date.now() / 1000);
const token = (subject: string) =>
	sign(
		{ iss: issuer, sub: subject, aud: audience, iat: now(), exp: now() + 600 },
		privateKey,
		"RS256",
	);

const app =
	uri && database
		? createApp({
				corsOrigin: "http://localhost:3001",
				auth: { issuer, audience, db: { uri, database } },
				voice: {
					apiKey: undefined,
					voiceId: "unused",
					baseUrl: "http://127.0.0.1:1",
				},
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

const newFamily = async (subject: string) => {
	const created = await call(subject, "POST", "/api/families", {
		name: "Rivera",
	});
	return `/api/families/${Schema.decodeUnknownSync(Family)(await created.json()).id}`;
};

describe.skipIf(app === undefined)("family chat routes", () => {
	test("a message is stored once across resends and read back by members only", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const bob = `bob-${crypto.randomUUID()}`;
		const path = await newFamily(alice);
		const send = { clientId: "phone-1", body: "Picked up her prescription" };

		const sent = await call(alice, "POST", `${path}/messages`, send);
		expect(sent.status).toBe(201);
		const stored = Schema.decodeUnknownSync(FamilyMessage)(await sent.json());
		expect(stored).toMatchObject(send);

		// The phone lost the reply and resends; every request opens a new database connection.
		const resent = await call(alice, "POST", `${path}/messages`, send);
		expect([resent.status, await resent.json()]).toEqual([201, stored]);
		const list = Schema.decodeUnknownSync(FamilyMessages)(
			await (await call(alice, "GET", `${path}/messages`)).json(),
		);
		expect(list.messages).toEqual([stored]);
		expect(
			await (
				await call(alice, "GET", `${path}/messages?after=${stored.id}`)
			).json(),
		).toEqual({ messages: [] });

		expect(
			await errorOf(
				await call(alice, "POST", `${path}/messages`, {
					...send,
					body: "Another",
				}),
			),
		).toEqual([400, "invalid_request"]);
		expect(await errorOf(await call(bob, "GET", `${path}/messages`))).toEqual([
			403,
			"forbidden",
		]);
		expect(
			await errorOf(
				await call(bob, "POST", `${path}/messages`, {
					clientId: "x",
					body: "hi",
				}),
			),
		).toEqual([403, "forbidden"]);
	});

	test("malformed messages and cursors are rejected", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const path = await newFamily(alice);
		for (const body of [
			{ clientId: "a b", body: "x" },
			{ clientId: "a", body: "  " },
			{ clientId: "a" },
			{ clientId: "a", body: "x", sender: "someone" },
		]) {
			expect(
				await errorOf(await call(alice, "POST", `${path}/messages`, body)),
			).toEqual([400, "invalid_request"]);
		}
		expect(
			await errorOf(await call(alice, "GET", `${path}/messages?after=-1`)),
		).toEqual([400, "invalid_request"]);
	});
});
