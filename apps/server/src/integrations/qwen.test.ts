// Covers what routes/cues.test.ts does not: configuration from the environment and the transport
// failures. A local gRPC server that never answers stands in for River; test key only.
import { afterAll, describe, expect, test } from "bun:test";
import { Server, ServerCredentials, type ServerUnaryCall } from "@grpc/grpc-js";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { type QwenConfig, qwenConfigFrom, requestCue } from "./qwen";

const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
const { promise: cancelled, resolve: cancel } = Promise.withResolvers<void>();
const river = new Server();
river.register(
	"/river.api.v1.RiverService/ChatCompleteFromCheckpoint",
	(call: ServerUnaryCall<Buffer, Buffer>) => {
		call.on("cancelled", () => cancel());
		arrive();
	},
	(bytes: Buffer) => bytes,
	(bytes: Buffer) => bytes,
	"unary",
);
const port = await new Promise<number>((resolve, reject) =>
	river.bindAsync(
		"127.0.0.1:0",
		ServerCredentials.createInsecure(),
		(error, bound) => (error ? reject(error) : resolve(bound)),
	),
);
afterAll(() => river.forceShutdown());

const qwen: QwenConfig = {
	baseUrl: `http://127.0.0.1:${port}`,
	baseModel: "Qwen/Qwen3.5-9B",
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

describe("qwenConfigFrom", () => {
	const env = {
		QWEN_BASE_URL: "https://api.river.ai",
		QWEN_BASE_MODEL: "Qwen/Qwen3.5-9B",
		QWEN_CHECKPOINT: "river://run/cue",
		RIVER_API_KEY: "key",
	};

	test("all four values give the River config", () => {
		expect(qwenConfigFrom(env)).toEqual({
			baseUrl: "https://api.river.ai",
			baseModel: "Qwen/Qwen3.5-9B",
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
			"Set all of QWEN_BASE_URL, QWEN_BASE_MODEL, QWEN_CHECKPOINT, and RIVER_API_KEY, or none",
		);
	});
});

describe("requestCue transport", () => {
	test("an unreachable River (gRPC UNAVAILABLE) is unavailable, not an upstream error", async () => {
		const baseUrl = "http://127.0.0.1:1";
		expect(
			await Effect.runPromise(
				Effect.flip(requestCue({ ...qwen, baseUrl }, samples)),
			),
		).toMatchObject({
			_tag: "QwenUnavailable",
			message: "River has no capacity for the cue",
		});
	});

	test("a River that does not answer in 30 s times out and the call is cancelled", async () => {
		const failure = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Effect.flip(requestCue(qwen, samples)),
				);
				yield* Effect.promise(() => arrived);
				yield* TestClock.adjust("29 seconds");
				expect(fiber.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust("1 second");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(failure).toMatchObject({
			_tag: "QwenUpstreamError",
			message: "River cue request timed out",
		});
		await cancelled;
	});
});
