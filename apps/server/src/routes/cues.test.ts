// The provider tests talk HTTP to a local protocol server that speaks the OpenAI-compatible chat
// API River deployments expose. They prove this server's side of the protocol, not a live River
// deployment or a trained checkpoint.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ApiError, type HealthSample } from "@health/contracts";
import { CueKind, cueFormat, HealthCue } from "@health/contracts/cues";
import { Effect, Exit, Schema } from "effect";
import { Hono } from "hono";
import type { FamilyDb } from "../db";
import { ApiFailure, errorStatus, type FamilyEnv } from "../http";
import {
	type QwenConfig,
	renderCueInput,
	requestCue,
} from "../integrations/qwen";
import { cueRoutes, pickSamples } from "./cues";

let reply: (signal: AbortSignal) => Response | Promise<Response> = () =>
	new Response(null);
let seen: { authorization: string | null; body: unknown } | undefined;
const provider = Bun.serve({
	port: 0,
	async fetch(request) {
		seen = {
			authorization: request.headers.get("authorization"),
			body: await request.json(),
		};
		return reply(request.signal);
	},
});
afterAll(() => provider.stop(true));

const qwen: QwenConfig = {
	baseUrl: `${provider.url.origin}/v1/`,
	deployment: "dep-test",
	checkpoint: "river://run-test/sampler_weights/health-cue-v1-test",
	apiKey: "test-key",
};

const completion = (content: string, finish_reason = "stop") =>
	Response.json({
		id: "x",
		model: "dep-test",
		choices: [
			{ index: 0, message: { role: "assistant", content }, finish_reason },
		],
	});

const sample = (overrides: Partial<HealthSample>): HealthSample => ({
	id: "1",
	familyId: "7",
	metric: "steps",
	value: 420,
	unit: "count",
	sourceTime: "2026-10-04T09:00:00.000000Z",
	receivedAt: "2026-10-04T09:00:01.000000Z",
	source: "synthetic-demo",
	synthetic: true,
	quality: "validated",
	...overrides,
});

const failureOf = (config: QwenConfig | undefined) =>
	Effect.runPromise(Effect.flip(requestCue(config, [sample({})])));

describe("cue format", () => {
	test("the server sends exactly the prompt format training uses", () => {
		expect(cueFormat.version).toBe("health-cue-v1");
		expect(cueFormat.kinds).toEqual([...CueKind.literals]);
		expect(renderCueInput(cueFormat.example.readings)).toBe(
			cueFormat.example.user,
		);
	});
});

describe("sample selection", () => {
	const steps = sample({ id: "1" });
	const pulse = sample({
		id: "2",
		metric: "heart_rate",
		value: 71.5,
		unit: "bpm",
	});
	const samples = [
		steps,
		pulse,
		sample({ id: "3", quality: "unvalidated" }),
		sample({ id: "4", familyId: "8" }),
	];

	test("keeps the family's validated samples in request order", () => {
		expect(pickSamples(samples, "7", ["2", "1"])).toEqual([pulse, steps]);
	});

	test("rejects another family's sample and an unvalidated sample", () => {
		expect(() => pickSamples(samples, "7", ["1", "4"])).toThrow(
			new ApiFailure("invalid_request", "Sample 4 is not in this family"),
		);
		expect(() => pickSamples(samples, "7", ["3"])).toThrow(/unvalidated/);
	});
});

describe("cue route", () => {
	// Validation and configuration errors must answer before the database is read.
	const untouched = new Proxy({} as FamilyDb, {
		get: () => {
			throw new Error("database read");
		},
	});
	// This file runs without SpacetimeDB, so this stands in for the rows `readFamilyRecords` (db.ts)
	// reads: only the sample view has rows. Update it when that function reads rows differently.
	const dbWith = (samples: ReadonlyArray<HealthSample>) => {
		const none = { iter: () => [] };
		const rows = samples.map((s) => ({
			...s,
			id: BigInt(s.id),
			familyId: BigInt(s.familyId),
			sourceTime: { toISOString: () => s.sourceTime },
			receivedAt: { toISOString: () => s.receivedAt },
			quality: { tag: s.quality === "validated" ? "Validated" : "Unvalidated" },
		}));
		return {
			connection: {
				isActive: true,
				db: {
					myFamilies: none,
					myHealthSamples: { iter: () => rows },
					myAlerts: none,
					myMessages: none,
					myAcknowledgements: none,
				},
			},
		} as unknown as FamilyDb;
	};
	const appWith = (config: QwenConfig | undefined, db = untouched) => {
		const app = new Hono<FamilyEnv>()
			.use(async (c, next) => {
				c.set("db", db);
				c.set("familyId", 7n);
				await next();
			})
			.route("/", cueRoutes(config));
		// Same mapping as `createApp`, which needs sign-in and a database to reach this route.
		app.onError((error, c) =>
			error instanceof ApiFailure
				? c.json(
						{ error: error.code, message: error.message },
						errorStatus[error.code],
					)
				: c.json({ error: "internal", message: String(error) }, 500),
		);
		return app;
	};
	const post = (
		config: QwenConfig | undefined,
		body: string,
		db = untouched,
		signal: AbortSignal | null = null,
	) =>
		appWith(config, db).request("/cues", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal,
		});

	const demo = sample({ id: "1" });
	const watch = sample({
		id: "2",
		metric: "heart_rate",
		value: 71.5,
		unit: "bpm",
		source: "apple-health",
		synthetic: false,
	});
	const watchLater = sample({
		id: "3",
		metric: "heart_rate",
		value: 74,
		unit: "bpm",
		source: "apple-health",
		synthetic: false,
	});
	const familyDb = dbWith([
		demo,
		watch,
		watchLater,
		sample({ id: "4", quality: "unvalidated" }),
		sample({ id: "5", familyId: "8" }),
	]);
	const cueFor = (sampleIds: ReadonlyArray<string>) =>
		post(qwen, JSON.stringify({ sampleIds }), familyDb);

	test("an unconfigured deployment is unavailable, never a canned cue", async () => {
		const response = await post(
			undefined,
			JSON.stringify({ sampleIds: ["1"] }),
		);
		expect(response.status).toBe(503);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("unavailable");
	});

	test.each([
		["not JSON", "{"],
		["no samples", JSON.stringify({ sampleIds: [] })],
		["a repeated sample", JSON.stringify({ sampleIds: ["1", "1"] })],
		["an extra field", JSON.stringify({ sampleIds: ["1"], prompt: "x" })],
		[
			"too many samples",
			JSON.stringify({
				sampleIds: Array.from({ length: 33 }, (_, i) => `${i}`),
			}),
		],
	])("rejects %s", async (_, body) => {
		const response = await post(qwen, body);
		expect(response.status).toBe(400);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("invalid_request");
	});

	test("answers the provider's cue with its model and input provenance", async () => {
		reply = () =>
			completion('{"kind":"rest","text":"A calm evening may help."}');
		const before = Date.now();
		const response = await cueFor(["2", "3", "1"]);
		expect(response.status).toBe(200);
		const cue = Schema.decodeUnknownSync(HealthCue)(await response.json());
		expect(cue).toEqual({
			kind: "rest",
			text: "A calm evening may help.",
			format: "health-cue-v1",
			model: {
				provider: "river",
				deployment: "dep-test",
				checkpoint: qwen.checkpoint,
			},
			input: {
				sampleIds: ["2", "3", "1"],
				sources: ["apple-health", "synthetic-demo"],
				synthetic: true,
			},
			generatedAt: cue.generatedAt,
		});
		expect(Date.parse(cue.generatedAt)).toBeGreaterThanOrEqual(before);
		// The provider reads the samples in request order.
		expect(seen?.body).toMatchObject({
			messages: [
				{ role: "system" },
				{ role: "user", content: renderCueInput([watch, watchLater, demo]) },
			],
		});
	});

	test("marks a cue from real samples only as not synthetic", async () => {
		reply = () => completion('{"kind":"walk","text":"A short walk."}');
		const response = await cueFor(["2"]);
		expect(response.status).toBe(200);
		const { input } = Schema.decodeUnknownSync(HealthCue)(
			await response.json(),
		);
		expect(input).toEqual({
			sampleIds: ["2"],
			sources: ["apple-health"],
			synthetic: false,
		});
	});

	test.each([
		["another family's sample", ["1", "5"]],
		["an unvalidated sample", ["4"]],
	])("rejects %s without calling the provider", async (_, sampleIds) => {
		seen = undefined;
		const response = await cueFor(sampleIds);
		expect(response.status).toBe(400);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("invalid_request");
		expect(seen).toBeUndefined();
	});

	test.each([
		[
			"a deployment that is not serving",
			() => new Response("scaled to zero", { status: 503 }),
			503,
			"unavailable",
			"Qwen deployment is not serving",
		],
		[
			"an auth failure",
			() => new Response("bad key test-key", { status: 401 }),
			502,
			"upstream_error",
			"Qwen deployment returned HTTP 401",
		],
		[
			"an invalid cue",
			() => completion('{"kind":"diagnose","text":"x"}'),
			502,
			"upstream_error",
			"Qwen reply is not a valid cue",
		],
	])(
		"maps %s to %d %s and logs only the typed reason",
		async (_, make, status, code, message) => {
			reply = make;
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				const response = await cueFor(["1"]);
				expect(response.status).toBe(status);
				const body = Schema.decodeUnknownSync(ApiError)(await response.json());
				expect(body).toMatchObject({ error: code, message });
				expect(JSON.stringify(body)).not.toContain("test-key");
				expect(warn).toHaveBeenCalledWith("qwen cue failed", {
					_tag:
						code === "unavailable" ? "QwenUnavailable" : "QwenUpstreamError",
					message,
				});
			} finally {
				warn.mockRestore();
			}
		},
	);

	test("a client disconnect cancels the provider call and answers 499", async () => {
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		const { promise: closed, resolve: close } = Promise.withResolvers<void>();
		reply = (signal) => {
			signal.addEventListener("abort", () => close());
			arrive();
			return new Promise<Response>(() => {});
		};
		const controller = new AbortController();
		const pending = post(
			qwen,
			JSON.stringify({ sampleIds: ["1"] }),
			familyDb,
			controller.signal,
		);
		await arrived;
		controller.abort();
		const response = await pending;
		await closed;
		expect(response.status).toBe(499);
		expect(await response.text()).toBe("");
	});
});

describe("Qwen deployment adapter", () => {
	test("sends the trained prompt with the key and decodes one cue", async () => {
		reply = () =>
			completion('{"kind":"walk","text":"A short walk may feel good."}');
		const cue = await Effect.runPromise(requestCue(qwen, [sample({})]));
		expect(cue).toEqual({ kind: "walk", text: "A short walk may feel good." });
		expect(seen?.authorization).toBe("Bearer test-key");
		expect(seen?.body).toMatchObject({
			model: "dep-test",
			temperature: 0,
			stream: false,
			messages: [
				{ role: "system", content: cueFormat.system },
				{ role: "user", content: renderCueInput([sample({})]) },
			],
		});
	});

	test("no configuration is unavailable without a network call", async () => {
		seen = undefined;
		expect((await failureOf(undefined))._tag).toBe("QwenUnavailable");
		expect(seen).toBeUndefined();
	});

	test("a deployment that is not serving is unavailable", async () => {
		reply = () => new Response("scaled to zero", { status: 503 });
		expect((await failureOf(qwen))._tag).toBe("QwenUnavailable");
	});

	test.each([
		[
			"an auth failure",
			() => new Response("bad key test-key", { status: 401 }),
		],
		["a non-JSON cue", () => completion("Take a walk!")],
		["an unknown kind", () => completion('{"kind":"diagnose","text":"x"}')],
		[
			"an extra field",
			() => completion('{"kind":"walk","text":"x","why":"y"}'),
		],
		[
			"an over-long cue",
			() => completion(`{"kind":"walk","text":"${"x".repeat(161)}"}`),
		],
		[
			"a truncated reply",
			() => completion('{"kind":"walk","text":"x"}', "length"),
		],
		["a malformed completion", () => Response.json({ choices: [] })],
	])("%s is an upstream error that leaks no provider body", async (_, make) => {
		reply = make;
		const failure = await failureOf(qwen);
		expect(failure._tag).toBe("QwenUpstreamError");
		expect(failure.message).not.toContain("test-key");
	});

	test("interrupting the request aborts the provider call", async () => {
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		const { promise: closed, resolve: close } = Promise.withResolvers<void>();
		reply = (signal) => {
			signal.addEventListener("abort", () => close());
			arrive();
			return new Promise<Response>(() => {});
		};
		const controller = new AbortController();
		const run = Effect.runPromiseExit(requestCue(qwen, [sample({})]), {
			signal: controller.signal,
		});
		await arrived;
		controller.abort();
		const exit = await run;
		await closed;
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
