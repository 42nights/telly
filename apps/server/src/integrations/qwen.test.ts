// Covers what routes/cues.test.ts does not: configuration from the environment and the transport
// failures. A local protocol server stands in for the River deployment; test key only.
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { type QwenConfig, qwenConfigFrom, requestCue } from "./qwen";

let reply: (request: Request) => Response | Promise<Response>;
const server = Bun.serve({ port: 0, fetch: (request) => reply(request) });
afterAll(() => server.stop(true));

const qwen: QwenConfig = {
	baseUrl: `${server.url.origin}/v1//`,
	deployment: "dep-test",
	checkpoint: "river://run-test/sampler_weights/cue",
	apiKey: "test-key",
};
const samples = [
	{
		metric: "steps",
		value: 420,
		unit: "count",
		sourceTime: "2026-10-04T09:00:00.000000Z",
	},
] as const;
const failureOf = (config: QwenConfig) =>
	Effect.runPromise(Effect.flip(requestCue(config, samples)));

describe("qwenConfigFrom", () => {
	const env = {
		QWEN_BASE_URL: "https://river.example/v1",
		QWEN_DEPLOYMENT: "dep-1",
		QWEN_CHECKPOINT: "river://run/cue",
		RIVER_API_KEY: "key",
	};

	test("all four values give the deployment config", () => {
		expect(qwenConfigFrom(env)).toEqual({
			baseUrl: "https://river.example/v1",
			deployment: "dep-1",
			checkpoint: "river://run/cue",
			apiKey: "key",
		});
	});

	test("no values give no config, so the cue route answers unavailable", () => {
		expect(qwenConfigFrom({})).toBeUndefined();
		expect(
			qwenConfigFrom({ QWEN_BASE_URL: "", RIVER_API_KEY: "" }),
		).toBeUndefined();
	});

	test.each(Object.keys(env))("a set without %s stops startup", (missing) => {
		expect(() => qwenConfigFrom({ ...env, [missing]: undefined })).toThrow(
			"Set all of QWEN_BASE_URL, QWEN_DEPLOYMENT, QWEN_CHECKPOINT, and RIVER_API_KEY, or none",
		);
	});
});

describe("requestCue transport", () => {
	test("posts to chat/completions under the base URL without doubled slashes", async () => {
		let path = "";
		reply = (request) => {
			path = new URL(request.url).pathname;
			return Response.json({
				choices: [
					{ message: { content: '{"kind":"walk","text":"A short walk."}' } },
				],
			});
		};
		expect(await Effect.runPromise(requestCue(qwen, samples))).toEqual({
			kind: "walk",
			text: "A short walk.",
		});
		expect(path).toBe("/v1/chat/completions");
	});

	test("a rate-limited deployment (HTTP 429) is unavailable, not an upstream error", async () => {
		reply = () => new Response("slow down", { status: 429 });
		const failure = await failureOf(qwen);
		expect(failure._tag).toBe("QwenUnavailable");
		expect(failure.message).not.toContain("slow down");
	});

	test("an HTTP error names only the status", async () => {
		reply = () => new Response("trace test-key", { status: 500 });
		const failure = await failureOf(qwen);
		expect(failure).toMatchObject({
			_tag: "QwenUpstreamError",
			message: "Qwen deployment returned HTTP 500",
		});
	});

	test("a 200 reply that is not JSON is an upstream error", async () => {
		reply = () => new Response("<html>ok</html>");
		const failure = await failureOf(qwen);
		expect(failure).toMatchObject({
			_tag: "QwenUpstreamError",
			message: "Qwen deployment request failed",
		});
	});

	test("an unreachable deployment is an upstream error", async () => {
		const baseUrl = "http://127.0.0.1:1";
		expect(await failureOf({ ...qwen, baseUrl })).toMatchObject({
			_tag: "QwenUpstreamError",
			message: "Qwen deployment request failed",
		});
	});

	test("a deployment that does not answer in 20 s times out and the call is aborted", async () => {
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		const { promise: aborted, resolve: abort } = Promise.withResolvers<void>();
		reply = (request) => {
			request.signal.addEventListener("abort", () => abort());
			arrive();
			return new Promise<Response>(() => {});
		};
		const failure = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Effect.flip(requestCue(qwen, samples)),
				);
				yield* Effect.promise(() => arrived);
				yield* TestClock.adjust("19 seconds");
				expect(fiber.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust("1 second");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(failure).toMatchObject({
			_tag: "QwenUpstreamError",
			message: "Qwen deployment timed out",
		});
		await aborted;
	});
});
