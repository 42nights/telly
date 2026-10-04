// Runs with `bun run db:test`: the real app, a real local SpacetimeDB, and a test-only OIDC issuer on
// 127.0.0.1 whose key exists for this run only. The outbox transport is a local test double, so
// "sent" here proves the outbox protocol, not delivery by a family provider.
import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, Family, FamilyRecords } from "@health/contracts";
import {
	AcknowledgedAlert,
	AlertThreshold,
	AlertThresholds,
	FamilyAlerts,
	Monitoring,
} from "@health/contracts/alerts";
import { FamilyList } from "@health/contracts/families";
import { Effect, Fiber, Schema } from "effect";
import { sign } from "hono/jwt";
import { runAlertOutbox } from "../alerts/outbox";
import { createApp } from "../app";
import { openFamilyDb } from "../db";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const operatorToken = process.env.SPACETIMEDB_OPERATOR_TOKEN;

const keys = await crypto.subtle.generateKey(
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
	kid: "alerts-test",
	alg: "RS256",
});
const publicJwk = await jwk(keys.publicKey);
const privateJwk = await jwk(keys.privateKey);
const issuerServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request): Response =>
		new URL(request.url).pathname === "/jwks"
			? Response.json({ keys: [publicJwk] })
			: Response.json({ issuer, jwks_uri: `${issuer}/jwks` }),
});
const issuer = `http://127.0.0.1:${issuerServer.port}`;
afterAll(() => issuerServer.stop(true));

const app =
	uri && database
		? createApp({
				corsOrigin: "http://localhost:3001",
				auth: { issuer, audience: "telly-alerts-test", db: { uri, database } },
				voice: {
					apiKey: undefined,
					voiceId: "unused",
					baseUrl: "http://127.0.0.1:1",
				},
			})
		: undefined;

type Caller = (
	method: string,
	path: string,
	body?: unknown,
) => Promise<Response>;

const as =
	(subject: string): Caller =>
	async (method, path, body) => {
		if (app === undefined) throw new Error("SPACETIMEDB_URI is unset");
		const iat = Math.floor(Date.now() / 1000);
		const bearer = await sign(
			{
				iss: issuer,
				sub: subject,
				aud: "telly-alerts-test",
				iat,
				exp: iat + 600,
			},
			privateJwk,
			"RS256",
		);
		return app.request(path, {
			method,
			headers: {
				Authorization: `Bearer ${bearer}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	};

const decoded = async <T>(schema: Schema.Decoder<T>, response: Response) => {
	expect(response.status).toBeLessThan(300);
	return Schema.decodeUnknownSync(schema)(await response.json(), {
		onExcessProperty: "error",
	});
};
const errorOf = async (response: Response) => [
	response.status,
	Schema.decodeUnknownSync(ApiError)(await response.json()).error,
];

const newFamily = async (call: Caller) =>
	`/api/families/${(await decoded(Family, await call("POST", "/api/families", { name: "Synthetic" }))).id}`;

const heartRule = {
	metric: "heart_rate",
	direction: "above",
	limit: 110,
	unit: "bpm",
	maxAgeSeconds: 300,
};

describe.skipIf(app === undefined)("alert routes", () => {
	test("a synthetic sample becomes a delivered, acknowledged family alert; other families are refused", async () => {
		const alice = as(`alice-${crypto.randomUUID()}`);
		const bob = as(`bob-${crypto.randomUUID()}`);
		const family = await newFamily(alice);

		for (const bad of [
			{ ...heartRule, maxAgeSeconds: 0 },
			{ ...heartRule, metric: " " },
			{ ...heartRule, familyId: "1" },
		])
			expect(
				await errorOf(await alice("PUT", `${family}/alert-thresholds`, bad)),
			).toEqual([400, "invalid_request"]);
		const rule = await decoded(
			AlertThreshold,
			await alice("PUT", `${family}/alert-thresholds`, heartRule),
		);
		expect(
			await decoded(
				AlertThresholds,
				await alice("GET", `${family}/alert-thresholds`),
			),
		).toEqual({ thresholds: [rule] });
		expect(
			await errorOf(await bob("GET", `${family}/alert-thresholds`)),
		).toEqual([403, "forbidden"]);
		const before = await decoded(
			Monitoring,
			await alice("GET", `${family}/monitoring`),
		);
		expect(before.thresholds.map((t) => [t.state, t.reason])).toEqual([
			["unavailable", "missing"],
		]);

		expect(
			(
				await alice("POST", `${family}/samples`, {
					metric: "heart_rate",
					value: 131,
					unit: "bpm",
					sourceTime: new Date(Date.now() - 1000).toISOString(),
					source: "synthetic-demo",
					synthetic: true,
					quality: "validated",
				})
			).status,
		).toBe(201);
		const { alerts } = await decoded(
			FamilyAlerts,
			await alice("GET", `${family}/alerts`),
		);
		const [raised] = alerts;
		if (raised === undefined) throw new Error("no alert was raised");
		expect(alerts).toHaveLength(1);
		expect(raised.sample).toMatchObject({ value: 131, synthetic: true });
		expect(raised.delivery?.status).toBe("queued");
		const after = await decoded(
			Monitoring,
			await alice("GET", `${family}/monitoring`),
		);
		expect(after.thresholds.map((t) => t.state)).toEqual(["out_of_range"]);

		// Bob, in his own family, can neither read nor acknowledge Alice's alert by any path.
		const ack = `/alerts/${raised.alert.id}/acknowledgements`;
		const bobFamily = await newFamily(bob);
		expect(await errorOf(await bob("GET", `${family}/alerts`))).toEqual([
			403,
			"forbidden",
		]);
		expect(await errorOf(await bob("POST", `${family}${ack}`))).toEqual([
			403,
			"forbidden",
		]);
		expect(await errorOf(await bob("POST", `${bobFamily}${ack}`))).toEqual([
			404,
			"not_found",
		]);
		expect(
			await errorOf(
				await bob("DELETE", `${bobFamily}/alert-thresholds/${rule.id}`),
			),
		).toEqual([404, "not_found"]);

		if (
			operatorToken === undefined ||
			uri === undefined ||
			database === undefined
		)
			throw new Error("SPACETIMEDB_OPERATOR_TOKEN is unset");
		const delivered = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const operator = yield* openFamilyDb({
						uri,
						database,
						token: operatorToken,
					});
					const worker = yield* Effect.forkScoped(
						runAlertOutbox(operator, () => Effect.void, "50 millis"),
					);
					for (;;) {
						const body = yield* Effect.promise(async () =>
							decoded(FamilyAlerts, await alice("GET", `${family}/alerts`)),
						);
						if (body.alerts[0]?.delivery?.status === "sent") break;
						yield* Effect.sleep("50 millis");
					}
					yield* Fiber.interrupt(worker);
					return true;
				}),
			),
		);
		expect(delivered).toBe(true);

		const first = await decoded(
			AcknowledgedAlert,
			await alice("POST", `${family}${ack}`),
		);
		const again = await decoded(
			AcknowledgedAlert,
			await alice("POST", `${family}${ack}`),
		);
		expect(again).toEqual(first);
		const final = await decoded(
			FamilyAlerts,
			await alice("GET", `${family}/alerts`),
		);
		expect(final.alerts[0]?.delivery?.status).toBe("sent");
		expect(final.alerts[0]?.acknowledgements).toEqual([first.acknowledgement]);

		// The family view and the family list hold Alice's rows only, never Bob's family or message.
		const note = { clientId: "alerts-note", body: "Saw the alert" };
		expect((await alice("POST", `${family}/messages`, note)).status).toBe(201);
		expect((await bob("POST", `${bobFamily}/messages`, note)).status).toBe(201);
		const familyId = raised.alert.familyId;
		const records = await decoded(FamilyRecords, await alice("GET", family));
		expect(records.families.map((f) => f.id)).toEqual([familyId]);
		expect(records.samples.map((s) => s.familyId)).toEqual([familyId]);
		expect(records.alerts.map((a) => a.id)).toEqual([raised.alert.id]);
		expect(records.acknowledgements).toEqual([first.acknowledgement]);
		expect(records.messages.map((m) => [m.familyId, m.body])).toEqual([
			[familyId, note.body],
		]);
		expect(
			(
				await decoded(FamilyList, await alice("GET", "/api/families"))
			).families.map((f) => f.id),
		).toEqual([familyId]);

		expect(
			(await alice("DELETE", `${family}/alert-thresholds/${rule.id}`)).status,
		).toBe(204);
		const none = await decoded(
			Monitoring,
			await alice("GET", `${family}/monitoring`),
		);
		expect(none.thresholds).toEqual([]);
	}, 20_000);
});
