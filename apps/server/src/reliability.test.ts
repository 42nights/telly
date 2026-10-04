// Runs the built server under Node (`dist/index.mjs`) against a real local SpacetimeDB:
// `bun run db:test` builds the server, starts the database, and sets SPACETIMEDB_URI and
// SPACETIMEDB_DATABASE. The OIDC issuer is a test-only server on 127.0.0.1 with a key made for this
// run, and a TCP proxy in front of the database causes the failures. All data is synthetic.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Effect } from "effect";
import { sign } from "hono/jwt";
import { Timestamp } from "spacetimedb";
import { runAlertOutbox } from "./alerts/outbox";
import { readAlerts } from "./alerts/records";
import { callDb, type FamilyDb, openFamilyDb, readFamilyRecords } from "./db";
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
const operatorToken = process.env.SPACETIMEDB_OPERATOR_TOKEN;

/** A new family owned by `member` whose fresh 140 bpm sample raised one alert with a queued delivery. */
const raiseQueuedAlert = (member: FamilyDb) =>
	Effect.gen(function* () {
		const name = crypto.randomUUID();
		yield* callDb(member, (c) => c.reducers.createFamily({ name }));
		const familyId = readFamilyRecords(member).families.find(
			(family) => family.name === name,
		)?.id;
		if (familyId === undefined) throw new Error("no family");
		yield* callDb(member, (c) =>
			c.reducers.setAlertThreshold({
				familyId: BigInt(familyId),
				metric: "heart_rate",
				direction: { tag: "Above" },
				limit: 110,
				unit: "bpm",
				maxAgeSeconds: 300,
			}),
		);
		yield* callDb(member, (c) =>
			c.reducers.recordSample({
				familyId: BigInt(familyId),
				metric: "heart_rate",
				value: 140,
				unit: "bpm",
				sourceTime: Timestamp.fromDate(new Date(Date.now() - 1000)),
				source: "synthetic-demo",
				synthetic: true,
				quality: { tag: "Validated" },
			}),
		);
		expect(readAlerts(member, familyId)[0]?.delivery?.status).toBe("queued");
		return familyId;
	});

// Runs before the server starts, so no other worker takes the queued delivery first.
describe.skipIf(fixtures === undefined)("the alert outbox loop", () => {
	test("ends at once, instead of hanging, when its connection drops during a delivery step", async () => {
		if (!uri || !database || !operatorToken)
			throw new Error("db:test passes SPACETIMEDB_OPERATOR_TOKEN");
		const cut = await dbProxy(uri);
		cut.setMode("drop-call");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* raiseQueuedAlert(yield* openFamilyDb({ uri, database }));
					const operator = yield* openFamilyDb({
						uri: cut.uri,
						database,
						token: operatorToken,
					});
					const ended = yield* Effect.flip(
						runAlertOutbox(operator, undefined, "10 millis"),
					);
					expect(ended).toEqual(new Error("operator connection closed"));
				}),
			),
		);
		cut.close();
	});
});

describe.skipIf(fixtures === undefined)(
	"the server under database failures",
	() => {
		if (fixtures === undefined || database === undefined) return;
		const { link, issuerServer, issuer, token } = fixtures;
		let base = "";
		let server: ChildProcess;
		// Starts the server on a port the OS picked as free. The outbox worker runs as the delivery
		// operator when db:test passes SPACETIMEDB_OPERATOR_TOKEN.
		const startServer = async () => {
			const probe = createServer();
			const bound = Promise.withResolvers<void>();
			probe.listen(0, "127.0.0.1", bound.resolve);
			await bound.promise;
			const address = probe.address();
			if (address === null || typeof address === "string")
				throw new Error("no free port");
			probe.close();
			base = `http://127.0.0.1:${address.port}`;
			server = spawn("node", ["dist/index.mjs"], {
				cwd: new URL("../", import.meta.url),
				env: {
					...process.env,
					NODE_ENV: "production",
					PORT: String(address.port),
					OIDC_ISSUER: issuer,
					OIDC_AUDIENCE: audience,
					SPACETIMEDB_URI: link.uri,
					SPACETIMEDB_DATABASE: database,
					ALERT_OPERATOR_TOKEN: process.env.SPACETIMEDB_OPERATOR_TOKEN,
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
		};
		beforeAll(startServer);
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

		test("a queued alert delivery survives an operator outage and a server crash, then the worker processes it", async () => {
			if (uri === undefined || !operatorToken)
				throw new Error("db:test passes SPACETIMEDB_OPERATOR_TOKEN");
			// Cut the outbox worker off: drop its connection and refuse new ones.
			link.setMode("refuse");
			link.drop();
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						// A family member, connected directly to the database, raises an alert.
						const member = yield* openFamilyDb({ uri, database });
						const familyId = yield* raiseQueuedAlert(member);
						const delivery = () => readAlerts(member, familyId)[0]?.delivery;

						// Crash the server while the delivery is queued, then start a new one.
						const exited = once(server, "exit");
						server.kill("SIGKILL");
						yield* Effect.promise(() => exited);
						yield* Effect.promise(startServer);
						expect(delivery()?.status).toBe("queued");
						link.setMode("pass");

						// The worker reopens its connection every 5 s. Without a transport it marks the
						// delivery `unavailable`. Poll: the SDK has no event for another identity's write.
						for (
							const end = Date.now() + 15_000;
							delivery()?.status === "queued" && Date.now() < end;
						)
							yield* Effect.promise(() => Bun.sleep(100));
						expect(delivery()).toMatchObject({
							status: "unavailable",
							attempts: 0,
							lastError: "No family delivery transport is configured",
						});
						expect(readAlerts(member, familyId)).toHaveLength(1);
					}),
				),
			);
		}, 30_000);

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
