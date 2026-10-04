// The provider tests talk HTTP to a local protocol server that speaks the OpenAI-compatible chat
// API River deployments expose. They prove this server's side of the protocol, not a live River
// deployment or a trained checkpoint.
import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, type HealthSample } from "@health/contracts";
import { CueKind, cueFormat } from "@health/contracts/cues";
import { Effect, Exit, Schema } from "effect";
import { Hono } from "hono";
import type { FamilyDb } from "../db";
import { ApiFailure, errorStatus, type FamilyEnv } from "../http";
import {
	type GemmaConfig,
	renderCueInput,
	requestCue,
} from "../integrations/gemma";
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

const gemma: GemmaConfig = {
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

const failureOf = (config: GemmaConfig | undefined) =>
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
	const appWith = (config: GemmaConfig | undefined) => {
		const app = new Hono<FamilyEnv>()
			.use(async (c, next) => {
				c.set("db", untouched);
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
	const post = (config: GemmaConfig | undefined, body: string) =>
		appWith(config).request("/cues", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});

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
		const response = await post(gemma, body);
		expect(response.status).toBe(400);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("invalid_request");
	});
});

describe("Gemma deployment adapter", () => {
	test("sends the trained prompt with the key and decodes one cue", async () => {
		reply = () =>
			completion('{"kind":"walk","text":"A short walk may feel good."}');
		const cue = await Effect.runPromise(requestCue(gemma, [sample({})]));
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
		expect((await failureOf(undefined))._tag).toBe("GemmaUnavailable");
		expect(seen).toBeUndefined();
	});

	test("a deployment that is not serving is unavailable", async () => {
		reply = () => new Response("scaled to zero", { status: 503 });
		expect((await failureOf(gemma))._tag).toBe("GemmaUnavailable");
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
		const failure = await failureOf(gemma);
		expect(failure._tag).toBe("GemmaUpstreamError");
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
		const run = Effect.runPromiseExit(requestCue(gemma, [sample({})]), {
			signal: controller.signal,
		});
		await arrived;
		controller.abort();
		const exit = await run;
		await closed;
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
