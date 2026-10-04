// Runs the mounted chat routes in the real app against a real local SpacetimeDB (`bun run db:test`).
// Test-only stand-ins, all on 127.0.0.1: an OIDC issuer, an xAI Responses API server with scripted
// replies, an ElevenLabs server, and an in-process Fetch.ai caller that reads as a worker identity.
// None of this is a live provider round trip.
import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, Family, FamilyMessage } from "@health/contracts";
import {
	FamilyAnswer,
	FamilyMessages,
	VoiceAnswer,
} from "@health/contracts/chat";
import { Me } from "@health/contracts/families";
import { Effect, Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "../app";
import type { ServerConfig } from "../config";
import { openFamilyDb } from "../db";
import { type AgentToolCaller, AgentToolError } from "../family-agent";
import { runTool } from "../tools";

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

let modelReplies: Array<unknown> = [];
let speechStatus = 200;
// One local server plays the OIDC issuer, xAI, and ElevenLabs.
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request): Response => {
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/openid-configuration")
			return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
		if (pathname === "/jwks") return Response.json({ keys: [publicKey] });
		if (pathname === "/v1/responses")
			return Response.json(modelReplies.shift() ?? {});
		if (pathname === "/v1/speech-to-text")
			return Response.json({
				text: "¿Cómo duerme mamá?",
				language_code: "spa",
				language_probability: 0.98,
			});
		if (pathname.startsWith("/v1/text-to-speech/"))
			return new Response(new Uint8Array([0xff, 0xf3, 1, 2]), {
				status: speechStatus,
				headers: { "content-type": "audio/mpeg" },
			});
		return new Response(null, { status: 404 });
	},
});
const local = `http://127.0.0.1:${server.port}`;
const issuer = local;
afterAll(() => server.stop(true));

const now = () => Math.floor(Date.now() / 1000);
const token = (subject: string) =>
	sign(
		{ iss: issuer, sub: subject, aud: audience, iat: now(), exp: now() + 600 },
		privateKey,
		"RS256",
	);

const worker = `fetch-worker-${crypto.randomUUID()}`;
let toolCalls = 0;
// Stands in for the Fetch.ai Agentverse transport: the worker reads with its own identity.
const viaWorker: AgentToolCaller = (familyId, request) => {
	toolCalls++;
	return Effect.scoped(
		Effect.gen(function* () {
			if (uri === undefined || database === undefined)
				throw new Error("no database");
			const db = yield* openFamilyDb({
				uri,
				database,
				token: yield* Effect.promise(() => token(worker)),
			});
			return runTool(db, familyId.toString(), request);
		}),
	).pipe(
		Effect.mapError(
			() =>
				new AgentToolError({
					reason: "unavailable",
					message: "worker unreachable",
				}),
		),
	);
};

const appWith = (overrides: Partial<ServerConfig>) =>
	uri && database
		? createApp({
				corsOrigin: "http://localhost:3001",
				auth: { issuer, audience, db: { uri, database } },
				grokbot: {
					apiKey: "test-key",
					model: "grok-test",
					baseUrl: `${local}/v1`,
				},
				callTool: viaWorker,
				elevenLabs: { apiKey: "test-key", voiceId: "voice", baseUrl: local },
				...overrides,
			})
		: undefined;
const app = appWith({});

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

const newFamily = async (subject: string) => {
	const created = await call(subject, "POST", "/api/families", {
		name: "Rivera",
	});
	return `/api/families/${Schema.decodeUnknownSync(Family)(await created.json()).id}`;
};
const identityOf = async (subject: string) =>
	Schema.decodeUnknownSync(Me)(
		await (await call(subject, "GET", "/api/me")).json(),
	).identity;
const sample = (metric: string, sourceTime: string) => ({
	metric,
	value: 6.7,
	unit: "h",
	sourceTime,
	source: "synthetic-demo",
	synthetic: true,
	quality: "unvalidated",
});

const done = { status: "completed", model: "grok-test" };
const toolCall = (call_id: string, name: string, input: unknown) => ({
	type: "function_call",
	call_id,
	name,
	arguments: JSON.stringify(input),
});
const answer = (text: string) => ({
	...done,
	output: [{ type: "message", content: [{ type: "output_text", text }] }],
});

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

	test("malformed messages, cursors, and questions are rejected", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const path = await newFamily(alice);
		for (const body of [
			{ clientId: "a b", body: "x" },
			{ clientId: "a", body: "  " },
			{ clientId: "a" },
		]) {
			expect(
				await errorOf(await call(alice, "POST", `${path}/messages`, body)),
			).toEqual([400, "invalid_request"]);
		}
		expect(
			await errorOf(await call(alice, "GET", `${path}/messages?after=-1`)),
		).toEqual([400, "invalid_request"]);
		expect(
			await errorOf(
				await call(alice, "POST", `${path}/ask`, {
					question: "hi",
					timeZone: "Mars/Base",
				}),
			),
		).toEqual([400, "invalid_request"]);
	});

	test("an answer cites only the family's records from Fetch.ai tool calls and names missing ones", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const carol = `carol-${crypto.randomUUID()}`;
		const path = await newFamily(alice);
		const other = await newFamily(carol);
		await call(alice, "POST", `${path}/members`, {
			identity: await identityOf(worker),
		});
		await call(carol, "POST", `${other}/members`, {
			identity: await identityOf(worker),
		});
		await call(
			alice,
			"POST",
			`${path}/samples`,
			sample("sleep_hours", "2026-01-01T07:00:00.000Z"),
		);
		await call(
			carol,
			"POST",
			`${other}/samples`,
			sample("sleep_hours", new Date().toISOString()),
		);

		modelReplies = [
			{
				...done,
				output: [
					toolCall("a", "health_samples", { metric: "sleep_hours" }),
					toolCall("b", "health_samples", { metric: "breathing_rate" }),
					toolCall("c", "alerts", {}),
				],
			},
			answer("6.7 h on Jan 1 (synthetic, stale)."),
		];
		toolCalls = 0;
		const response = await call(alice, "POST", `${path}/ask`, {
			question: "How is Mom sleeping?",
		});
		expect(response.status).toBe(200);
		const reply = Schema.decodeUnknownSync(FamilyAnswer)(await response.json());
		expect(toolCalls).toBe(3);
		expect(reply.answer).toBe("6.7 h on Jan 1 (synthetic, stale).");
		expect(
			reply.evidence.map((e) => [e.metric, e.sourceTime, e.stale]),
		).toEqual([["sleep_hours", "2026-01-01T07:00:00.000000Z", true]]);
		expect(reply.alerts).toEqual([]);
		expect(reply.unavailable).toEqual(["breathing_rate"]);
	});

	test("a voice question gets a text answer and speech in the question's language", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const path = await newFamily(alice);
		const ask = async () =>
			app?.request(`${path}/ask/voice?timeZone=Europe/Madrid`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${await token(alice)}`,
					"Content-Type": "audio/webm",
				},
				body: new Uint8Array([1, 2, 3]),
			});
		modelReplies = [answer("No hay datos de sueño.")];
		speechStatus = 200;
		const spoken = Schema.decodeUnknownSync(VoiceAnswer)(
			await (await ask())?.json(),
		);
		expect(spoken.transcript.languageCode).toBe("es");
		expect(spoken.answer.answer).toBe("No hay datos de sueño.");
		expect(spoken.speech).toEqual({
			status: "ok",
			languageCode: "es",
			audio: "//MBAg==",
		});

		// Speech fails: the text answer still arrives, and the failure is explicit.
		modelReplies = [answer("No hay datos de sueño.")];
		speechStatus = 500;
		const silent = Schema.decodeUnknownSync(VoiceAnswer)(
			await (await ask())?.json(),
		);
		expect(silent.answer.answer).toBe("No hay datos de sueño.");
		expect(silent.speech.status).toBe("upstream_error");
	});

	test("missing or failing providers are reported, never answered", async () => {
		const alice = `alice-${crypto.randomUUID()}`;
		const path = await newFamily(alice);
		const ask = (target = app) =>
			call(alice, "POST", `${path}/ask`, { question: "hi" }, target);
		expect(await errorOf(await ask(appWith({ grokbot: undefined })))).toEqual([
			503,
			"unavailable",
		]);
		expect(await errorOf(await ask(appWith({ callTool: undefined })))).toEqual([
			503,
			"unavailable",
		]);

		modelReplies = [{ unexpected: true }];
		expect(await errorOf(await ask())).toEqual([502, "upstream_error"]);

		const down: AgentToolCaller = () =>
			Effect.fail(
				new AgentToolError({
					reason: "unavailable",
					message: "Fetch.ai is unreachable",
				}),
			);
		modelReplies = [{ ...done, output: [toolCall("a", "alerts", {})] }];
		expect(await errorOf(await ask(appWith({ callTool: down })))).toEqual([
			503,
			"unavailable",
		]);
	});
});
