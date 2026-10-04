// The code exchange and the phone return, against a test-only issuer on 127.0.0.1. Google itself is
// not called here; this proves what the server sends and what it never gives to a client.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ApiError } from "@health/contracts";
import { Schema } from "effect";
import { createApp } from "../app";
import type { AuthConfig } from "../auth";

const exchanges: URLSearchParams[] = [];
let tokenStatus = 200;
// `null` leaves the token endpoint out of discovery; a string replaces it.
let tokenEndpoint: string | null | undefined;
const idToken = JSON.stringify({ id_token: "header.payload.signature" });
let tokenBody = idToken;
const issuerServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/openid-configuration")
			return Response.json({
				issuer,
				jwks_uri: `${issuer}/jwks`,
				...(tokenEndpoint !== null && {
					token_endpoint: tokenEndpoint ?? `${issuer}/token`,
				}),
			});
		if (pathname === "/token") {
			exchanges.push(new URLSearchParams(await request.text()));
			return tokenStatus === 200
				? new Response(tokenBody, {
						headers: { "Content-Type": "application/json" },
					})
				: Response.json({ error: "invalid_grant" }, { status: tokenStatus });
		}
		return new Response(null, { status: 404 });
	},
});
const issuer = `http://127.0.0.1:${issuerServer.port}`;
afterAll(() => issuerServer.stop(true));

const base = {
	corsOrigin: "http://localhost:3001",
	voice: {
		apiKey: undefined,
		voiceId: "unused",
		baseUrl: "http://127.0.0.1:1",
	},
};
const auth = {
	issuer,
	audience: "telly-web",
	clientSecret: "test-only-secret",
	// The sign-in routes never open the database.
	db: { uri: "ws://127.0.0.1:1", database: "unused" },
};
const exchange = {
	code: "one-time-code",
	codeVerifier: "v".repeat(43),
	redirectUri: "http://localhost:3001/sign-in",
};
const post = (signIn: AuthConfig | undefined, body: unknown) =>
	createApp({ ...base, auth: signIn }).request("/api/sign-in/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
const errorOf = async (response: Response) => [
	response.status,
	Schema.decodeUnknownSync(ApiError)(await response.json()).error,
];
// Nothing listens on port 1, so a connection there is refused at once.
const unreachable = "http://127.0.0.1:1";

describe("sign-in routes", () => {
	beforeEach(() => {
		tokenStatus = 200;
		tokenEndpoint = undefined;
		tokenBody = idToken;
	});
	test("the exchange adds the client secret on the server and returns only the ID token", async () => {
		const response = await post(auth, exchange);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({ idToken: "header.payload.signature" });
		expect(body).not.toContain("test-only-secret");
		expect(Object.fromEntries(exchanges.at(-1) ?? [])).toEqual({
			grant_type: "authorization_code",
			code: "one-time-code",
			code_verifier: exchange.codeVerifier,
			redirect_uri: exchange.redirectUri,
			client_id: "telly-web",
			client_secret: "test-only-secret",
		});
	});

	test("a public client sends no secret", async () => {
		const { clientSecret: _, ...publicAuth } = auth;
		await post(publicAuth, exchange);
		expect(exchanges.at(-1)?.has("client_secret")).toBe(false);
	});

	test("a refused code is a 400, a provider failure a 502, and no setup a 503", async () => {
		tokenStatus = 400;
		expect(await errorOf(await post(auth, exchange))).toEqual([
			400,
			"invalid_request",
		]);
		tokenStatus = 500;
		expect(await errorOf(await post(auth, exchange))).toEqual([
			502,
			"upstream_error",
		]);
		expect(await errorOf(await post(undefined, exchange))).toEqual([
			503,
			"unavailable",
		]);
	});

	test("an unreachable issuer, a missing token endpoint, or an unreachable one is a 503", async () => {
		expect(
			await errorOf(await post({ ...auth, issuer: unreachable }, exchange)),
		).toEqual([503, "unavailable"]);
		const sent = exchanges.length;
		for (const endpoint of [null, `${unreachable}/token`]) {
			tokenEndpoint = endpoint;
			expect(await errorOf(await post(auth, exchange))).toEqual([
				503,
				"unavailable",
			]);
		}
		expect(exchanges.length).toBe(sent);
	});

	test("a success reply without an ID token is a 502, never an empty sign-in", async () => {
		for (const body of [
			"not json",
			JSON.stringify({ access_token: "a" }),
			JSON.stringify({ id_token: "" }),
		]) {
			tokenBody = body;
			expect(await errorOf(await post(auth, exchange))).toEqual([
				502,
				"upstream_error",
			]);
		}
	});

	test("a body with extra keys or a short verifier is rejected before the issuer is called", async () => {
		const sent = exchanges.length;
		for (const body of [
			{ ...exchange, clientSecret: "smuggled" },
			{ ...exchange, codeVerifier: "short" },
		])
			expect((await post(auth, body)).status).toBe(400);
		expect(exchanges.length).toBe(sent);
	});

	test("the phone return forwards only code, state, and error to the app", async () => {
		const response = await createApp({ ...base, auth }).request(
			"/api/sign-in/callback?code=c1&state=s1&scope=openid&extra=x",
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"health://sign-in?code=c1&state=s1",
		);
	});
});
