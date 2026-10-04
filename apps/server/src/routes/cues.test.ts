// The provider tests talk gRPC to a local server that speaks River's queued chat API
// (`river.api.v1.RiverService`). They prove this server's side of the protocol, not live River or
// a trained checkpoint.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
	Server,
	ServerCredentials,
	type ServerUnaryCall,
	type sendUnaryData,
	status,
} from "@grpc/grpc-js";
import { ApiError, type HealthSample } from "@health/contracts";
import { CueKind, cueFormat, HealthCue } from "@health/contracts/cues";
import { Effect, Exit, Schema } from "effect";
import { Hono } from "hono";
import type { FamilyDb } from "../db";
import { ApiFailure, errorStatus, type FamilyEnv } from "../http";
import {
	encodeStrings,
	type QwenConfig,
	renderCueInput,
	requestCue,
} from "../integrations/qwen";
import { cueRoutes, pickSamples } from "./cues";

// Each RetrieveFuture poll takes the next answer: a chat reply, `try_again`, `failed`, or a gRPC
// error. With none left, the poll never answers.
type Answer =
	| { readonly status: number; readonly body: string }
	| "pending"
	| "failed"
	| { readonly code: status };
let answers: Array<Answer> = [];
let seen:
	| { key: unknown; checkpoint: string; baseModel: string; request: unknown }
	| undefined;
let polled = Promise.withResolvers<void>();
let cancelled = Promise.withResolvers<void>();

const LD = WireType.LengthDelimited;
const raw = (bytes: Buffer) => bytes;
const river = new Server();
river.register(
	"/river.api.v1.RiverService/ChatCompleteFromCheckpoint",
	(call: ServerUnaryCall<Buffer, Buffer>, done: sendUnaryData<Buffer>) => {
		const fields = new Map<number, string>();
		const reader = new BinaryReader(call.request);
		while (reader.pos < reader.len)
			fields.set(reader.tag()[0], reader.string());
		seen = {
			key: call.metadata.get("x-api-key")[0],
			checkpoint: fields.get(1) ?? "",
			baseModel: fields.get(2) ?? "",
			request: JSON.parse(fields.get(3) ?? "null"),
		};
		done(null, encodeStrings([[1, "request-1"]]));
	},
	raw,
	raw,
	"unary",
);
river.register(
	"/river.api.v1.RiverService/RetrieveFuture",
	(call: ServerUnaryCall<Buffer, Buffer>, done: sendUnaryData<Buffer>) => {
		const answer = answers.shift();
		polled.resolve();
		if (answer === undefined)
			return void call.on("cancelled", () => cancelled.resolve());
		if (typeof answer === "object" && "code" in answer)
			return done({ code: answer.code, details: "bad key test-key" }, null);
		const writer = new BinaryWriter();
		if (answer === "pending")
			writer.tag(1, LD).fork().tag(1, LD).string("request-1").join();
		else if (answer === "failed")
			writer.tag(2, LD).fork().tag(2, LD).string("test-key").join();
		else
			writer
				.tag(12, LD)
				.fork()
				.tag(1, LD)
				.string(answer.body)
				.tag(2, WireType.Varint)
				.int32(answer.status)
				.join();
		done(null, Buffer.from(writer.finish()));
	},
	raw,
	raw,
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
	checkpoint: "river://run-test/sampler_weights/health-cue-v1-test",
	apiKey: "test-key",
};

const completion = (content: string, finish_reason = "stop") => ({
	status: 200,
	body: JSON.stringify({
		id: "x",
		choices: [
			{ index: 0, message: { role: "assistant", content }, finish_reason },
		],
	}),
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
	const whoop = sample({
		id: "3",
		quality: "unvalidated",
		source: "noop:my-whoop",
		synthetic: false,
	});
	const samples = [steps, pulse, whoop, sample({ id: "4", familyId: "8" })];

	test("keeps the family's samples in request order, unvalidated too", () => {
		expect(pickSamples(samples, "7", ["2", "3", "1"])).toEqual([
			pulse,
			whoop,
			steps,
		]);
	});

	test("rejects another family's sample", () => {
		expect(() => pickSamples(samples, "7", ["1", "4"])).toThrow(
			new ApiFailure("invalid_request", "Sample 4 is not in this family"),
		);
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
		sample({ id: "5", familyId: "8" }),
		sample({
			id: "6",
			metric: "heart_rate",
			value: 68,
			unit: "bpm",
			source: "noop:my-whoop",
			synthetic: false,
			quality: "unvalidated",
		}),
		sample({
			id: "7",
			metric: "heart_rate",
			value: 70,
			unit: "bpm",
			source: "apple-health",
			synthetic: false,
			quality: "unvalidated",
		}),
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
		answers = [completion('{"kind":"rest","text":"A calm evening may help."}')];
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
				baseModel: qwen.baseModel,
				checkpoint: qwen.checkpoint,
			},
			input: {
				sampleIds: ["2", "3", "1"],
				sources: ["apple-health", "synthetic-demo"],
				synthetic: true,
				validated: true,
			},
			notice: null,
			generatedAt: cue.generatedAt,
		});
		expect(Date.parse(cue.generatedAt)).toBeGreaterThanOrEqual(before);
		// The provider reads the samples in request order.
		expect(seen?.request).toMatchObject({
			messages: [
				{ role: "system" },
				{ role: "user", content: renderCueInput([watch, watchLater, demo]) },
			],
		});
	});

	test("marks a cue from real samples only as not synthetic", async () => {
		answers = [completion('{"kind":"walk","text":"A short walk."}')];
		const response = await cueFor(["2"]);
		expect(response.status).toBe(200);
		const { input } = Schema.decodeUnknownSync(HealthCue)(
			await response.json(),
		);
		expect(input).toEqual({
			sampleIds: ["2"],
			sources: ["apple-health"],
			synthetic: false,
			validated: true,
		});
	});

	test("treats a real WHOOP sample as accurate and names only unchecked sources", async () => {
		answers = [completion('{"kind":"none","text":"No cue right now."}')];
		const response = await cueFor(["6"]);
		expect(response.status).toBe(200);
		const cue = Schema.decodeUnknownSync(HealthCue)(await response.json());
		expect(cue.input).toEqual({
			sampleIds: ["6"],
			sources: ["noop:my-whoop"],
			synthetic: false,
			validated: true,
		});
		expect(cue.notice).toBeNull();

		answers = [completion('{"kind":"none","text":"No cue right now."}')];
		const mixed = Schema.decodeUnknownSync(HealthCue)(
			await (await cueFor(["6", "7"])).json(),
		);
		expect(mixed.input.validated).toBe(false);
		expect(mixed.notice).toBe(
			"Based on unchecked readings from apple-health. Advice only; it never raises an alert.",
		);
	});

	test("rejects another family's sample without calling the provider", async () => {
		seen = undefined;
		const response = await cueFor(["1", "5"]);
		expect(response.status).toBe(400);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("invalid_request");
		expect(seen).toBeUndefined();
	});

	test.each<[string, Answer, number, string, string]>([
		[
			"a deployment that is not serving",
			{ status: 503, body: "scaled to zero" },
			503,
			"unavailable",
			"River has no capacity for the cue",
		],
		[
			"an auth failure",
			{ code: status.UNAUTHENTICATED },
			502,
			"upstream_error",
			"River cue request failed",
		],
		[
			"an invalid cue",
			completion('{"kind":"diagnose","text":"x"}'),
			502,
			"upstream_error",
			"Qwen reply is not a valid cue",
		],
	])(
		"maps %s to %d %s and logs only the typed reason",
		async (_, answer, httpStatus, code, message) => {
			answers = [answer];
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				const response = await cueFor(["1"]);
				expect(response.status).toBe(httpStatus);
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
		answers = [];
		polled = Promise.withResolvers<void>();
		cancelled = Promise.withResolvers<void>();
		const controller = new AbortController();
		const pending = post(
			qwen,
			JSON.stringify({ sampleIds: ["1"] }),
			familyDb,
			controller.signal,
		);
		await polled.promise;
		controller.abort();
		const response = await pending;
		await cancelled.promise;
		expect(response.status).toBe(499);
		expect(await response.text()).toBe("");
	});
});

describe("River queued chat adapter", () => {
	test("sends the trained prompt with the key, polls, and decodes one cue", async () => {
		answers = [
			"pending",
			completion('{"kind":"walk","text":"A short walk may feel good."}'),
		];
		const cue = await Effect.runPromise(requestCue(qwen, [sample({})]));
		expect(cue).toEqual({ kind: "walk", text: "A short walk may feel good." });
		expect(answers).toEqual([]);
		expect(seen?.key).toBe("test-key");
		expect(seen?.checkpoint).toBe(qwen.checkpoint);
		expect(seen?.baseModel).toBe(qwen.baseModel);
		expect(seen?.request).toMatchObject({
			model: qwen.baseModel,
			temperature: 0,
			chat_template_kwargs: { enable_thinking: false },
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

	test.each<[string, Answer]>([
		["a 503 chat reply", { status: 503, body: "" }],
		["gRPC UNAVAILABLE", { code: status.UNAVAILABLE }],
		["gRPC RESOURCE_EXHAUSTED", { code: status.RESOURCE_EXHAUSTED }],
	])("%s is unavailable", async (_, answer) => {
		answers = [answer];
		expect((await failureOf(qwen))._tag).toBe("QwenUnavailable");
	});

	test.each<[string, Answer]>([
		["an auth failure", { code: status.UNAUTHENTICATED }],
		["a failed request", "failed"],
		["a 400 chat reply", { status: 400, body: '{"error":"test-key"}' }],
		["a non-JSON cue", completion("Take a walk!")],
		["an unknown kind", completion('{"kind":"diagnose","text":"x"}')],
		["an extra field", completion('{"kind":"walk","text":"x","why":"y"}')],
		[
			"an over-long cue",
			completion(`{"kind":"walk","text":"${"x".repeat(161)}"}`),
		],
		["a truncated reply", completion('{"kind":"walk","text":"x"}', "length")],
		["a malformed completion", { status: 200, body: '{"choices":[]}' }],
	])(
		"%s is an upstream error that leaks no provider body",
		async (_, answer) => {
			answers = [answer];
			const failure = await failureOf(qwen);
			expect(failure._tag).toBe("QwenUpstreamError");
			expect(failure.message).not.toContain("test-key");
		},
	);

	test("interrupting the request cancels the River call", async () => {
		answers = [];
		polled = Promise.withResolvers<void>();
		cancelled = Promise.withResolvers<void>();
		const controller = new AbortController();
		const run = Effect.runPromiseExit(requestCue(qwen, [sample({})]), {
			signal: controller.signal,
		});
		await polled.promise;
		controller.abort();
		const exit = await run;
		await cancelled.promise;
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
