// Runs the built server under Node (`dist/index.mjs`) against a real local SpacetimeDB:
// `bun run db:test` builds the server, starts the database, and sets SPACETIMEDB_URI and
// SPACETIMEDB_DATABASE. The OIDC issuer is a test-only server on 127.0.0.1 with a key made for this
// run, and a TCP proxy in front of the database causes the failures. All data is synthetic.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { sign } from "hono/jwt";
import { closed, dbProxy } from "./db-proxy";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const audience = "telly-reliability-test";

const startFixtures = async (uri: string) => {
	const link = await dbProxy(uri);
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
	const jwk = async (key: CryptoKey) => ({
		...(await crypto.subtle.exportKey("jwk", key)),
		kid: "reliability",
		alg: "RS256",
	});
	const publicJwk = await jwk(pair.publicKey);
	const issuerServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request): Response => {
			const { pathname } = new URL(request.url);
			if (pathname === "/.well-known/openid-configuration")
				return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
			if (pathname === "/jwks") return Response.json({ keys: [publicJwk] });
			return new Response(null, { status: 404 });
		},
	});
	const issuer = `http://127.0.0.1:${issuerServer.port}`;
	const now = Math.floor(Date.now() / 1000);
	const token = await sign(
		{
			iss: issuer,
			sub: "reliability",
			aud: audience,
			iat: now,
			exp: now + 600,
		},
		await jwk(pair.privateKey),
		"RS256",
	);
	return { link, issuerServer, issuer, token };
};

const fixtures = uri && database ? await startFixtures(uri) : undefined;

describe.skipIf(fixtures === undefined)(
	"the server under database failures",
	() => {
		if (fixtures === undefined || database === undefined) return;
		const { link, issuerServer, issuer, token } = fixtures;
		const port = 3700 + Math.floor(Math.random() * 100);
		const base = `http://127.0.0.1:${port}`;
		let server: ChildProcess;
		beforeAll(async () => {
			server = spawn("node", ["dist/index.mjs"], {
				cwd: new URL("../", import.meta.url),
				env: {
					...process.env,
					NODE_ENV: "production",
					PORT: String(port),
					OIDC_ISSUER: issuer,
					OIDC_AUDIENCE: audience,
					SPACETIMEDB_URI: link.uri,
					SPACETIMEDB_DATABASE: database,
				},
				stdio: ["ignore", "pipe", "inherit"],
			});
			// Effect logs this line once the listener is bound. Keep reading stdout after it, so the
			// server never writes to a closed pipe.
			const listening = Promise.withResolvers<void>();
			server.stdout?.on("data", (chunk) => {
				if (String(chunk).includes("server listening")) listening.resolve();
			});
			await listening.promise;
		});
		afterAll(() => {
			server.kill("SIGKILL");
			link.close();
			issuerServer.stop(true);
		});

		const call = (
			method: "GET" | "POST",
			path: string,
			signal: AbortSignal | null = null,
		) =>
			fetch(`${base}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: method === "POST" ? JSON.stringify({ name: "Lost" }) : null,
				signal,
			});
		const unavailable = {
			error: "unavailable",
			message: "The database is not reachable",
		};

		test("a database outage answers 503 unavailable, and the next request reconnects", async () => {
			expect((await call("GET", "/api/me")).status).toBe(200);
			link.setMode("refuse");
			const outage = await call("GET", "/api/me");
			expect([outage.status, await outage.json()]).toEqual([503, unavailable]);
			link.setMode("pass");
			expect((await call("GET", "/api/me")).status).toBe(200);
		});

		test("a connection that drops during a reducer call answers 503 at once and writes nothing", async () => {
			link.setMode("drop-call");
			const started = Date.now();
			const dropped = await call("POST", "/api/families");
			expect([dropped.status, await dropped.json()]).toEqual([
				503,
				unavailable,
			]);
			// Well below the 5 s call timeout: the drop itself ends the call.
			expect(Date.now() - started).toBeLessThan(2_000);
			link.setMode("pass");
			const listed = await call("GET", "/api/families");
			expect(await listed.json()).toEqual({ families: [] });
		});

		// In "freeze" the next new socket (the SDK's token fetch, or its WebSocket when the fetch reuses
		// a pooled socket) gets no reply; it closes only if the open is really cancelled.
		test("a cancelled request closes its database connection", async () => {
			link.setMode("freeze");
			const accepted = link.nextSocket();
			const abort = new AbortController();
			const request = call("GET", "/api/me", abort.signal).catch(
				() => "cancelled",
			);
			const released = closed(await accepted);
			abort.abort();
			expect(await request).toBe("cancelled");
			// A leaked connection never closes, and the test times out here.
			await released;
			link.setMode("pass");
		});

		test("SIGTERM with a request waiting on the database exits within 5 s and closes its connection", async () => {
			link.setMode("freeze");
			const accepted = link.nextSocket();
			const request = call("GET", "/api/me").catch(() => "closed by shutdown");
			const released = closed(await accepted);
			const exited = once(server, "exit");
			const started = Date.now();
			server.kill("SIGTERM");
			await exited;
			expect(Date.now() - started).toBeLessThan(5_000);
			await released;
			expect(await request).toBe("closed by shutdown");
		}, 10_000);
	},
);
