import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ApiError } from "@health/contracts";
import { FamilyAnswer, VoiceAnswer } from "@health/contracts/ask";
import { Schema } from "effect";
import { Hono } from "hono";
import { ApiFailure, errorStatus, type FamilyEnv } from "../http";
import { elevenLabsVoice } from "../integrations/elevenlabs";
import { askRoutes } from "./ask";

// Isolated local protocol servers stand in for Gemini, the Fetch.ai bridge, and ElevenLabs. Test
// credentials and synthetic records only: local protocol proof, not live-provider proof.
type Body = { input: unknown[]; system_instruction: string; store: boolean };
const geminiBodies: Body[] = [];
let gemini: (body: Body, request: Request) => Response | Promise<Response>;
const geminiServer = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const body = (await request.json()) as Body;
		geminiBodies.push(body);
		return gemini(body, request);
	},
});

const sleepSample = (sourceTime: string) => ({
	id: "11",
	familyId: "7",
	metric: "sleep_hours",
	value: 7.5,
	unit: "h",
	sourceTime,
	receivedAt: sourceTime,
	source: "synthetic-demo",
	synthetic: true,
	quality: "unvalidated",
	recordedBy: "c200".padEnd(64, "0"),
});
const bridgeCalls: Array<{ family_id: string; request: unknown }> = [];
let samples: unknown[] = [];
const bridge = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const call = (await request.json()) as {
			family_id: string;
			request: unknown;
		};
		bridgeCalls.push(call);
		return Response.json({
			family_id: call.family_id,
			status: 200,
			body: { tool: "health_samples", samples },
		});
	},
});

let speech: () => Response;
const elevenLabs = Bun.serve({
	port: 0,
	fetch: (request) =>
		new URL(request.url).pathname === "/v1/speech-to-text"
			? Response.json({
					text: "How did Mom sleep?",
					language_code: "eng",
					language_probability: 0.98,
				})
			: speech(),
});
afterAll(() => {
	for (const server of [geminiServer, bridge, elevenLabs]) server.stop(true);
});

const functionCall = {
	status: "requires_action",
	model: "gemini-3.8-flash",
	steps: [
		{ type: "thought", signature: "sig-1" },
		{
			type: "function_call",
			id: "call_1",
			name: "health_samples",
			arguments: { metric: "sleep_hours", limit: 1 },
		},
	],
};
// The final turn is the structured answer: JSON text with `answer` and `follow_ups`.
const answer = (text: string, follow_ups: unknown = []) => ({
	status: "completed",
	model: "gemini-3.8-flash",
	steps: [
		{
			type: "model_output",
			content: [
				{ type: "text", text: JSON.stringify({ answer: text, follow_ups }) },
			],
		},
	],
});
const answerWith = (followUps: unknown) => {
	gemini = (body) =>
		Response.json(
			body.input.length === 1
				? functionCall
				: answer("Mom slept 7.5 hours (synthetic).", followUps),
		);
};
beforeEach(() => {
	geminiBodies.length = 0;
	bridgeCalls.length = 0;
	samples = [sleepSample(new Date().toISOString())];
	answerWith(["Did Mom nap today?"]);
	speech = () =>
		new Response(new Uint8Array([0xff, 0xf3, 1, 2]), {
			headers: { "content-type": "audio/mpeg" },
		});
});

const geminiConfig = {
	apiKey: "test-gemini-key",
	baseUrl: geminiServer.url.origin,
};
const fetchAgent = { bridgeUrl: bridge.url.origin, bridgeToken: "test-bridge" };
const mount = (configured = { gemini: true, fetch: true }) =>
	new Hono<FamilyEnv>()
		.use("/api/families/:familyId/*", async (c, next) => {
			c.set("familyId", BigInt(c.req.param("familyId") ?? ""));
			await next();
		})
		.route(
			"/api/families/:familyId",
			askRoutes({
				gemini: configured.gemini ? geminiConfig : undefined,
				fetchAgent: configured.fetch ? fetchAgent : undefined,
				voice: elevenLabsVoice({
					apiKey: "test-eleven-key",
					voiceId: "test-voice",
					baseUrl: elevenLabs.url.origin,
				}),
			}),
		)
		.onError((error, c) => {
			if (!(error instanceof ApiFailure)) throw error;
			return c.json(
				{ error: error.code, message: error.message } satisfies ApiError,
				errorStatus[error.code],
			);
		});
const app = mount();
const ask = (body: unknown, target = app, signal?: AbortSignal) =>
	target.request("http://test/api/families/7/ask", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: signal ?? null,
	});
const errorOf = async (response: Response) =>
	Schema.decodeUnknownSync(ApiError)(await response.json());

describe("POST /ask", () => {
	test("tool results go back to Gemini, and the answer lists the records it used", async () => {
		const response = await ask({ question: "How did Mom sleep?" });
		expect(response.status).toBe(200);
		const reply = Schema.decodeUnknownSync(FamilyAnswer)(await response.json());
		expect(reply.answer).toBe("Mom slept 7.5 hours (synthetic).");
		expect(reply.evidence.map((e) => [e.id, e.stale])).toEqual([["11", false]]);
		expect(reply.unavailable).toEqual([]);
		expect(reply.followUps).toEqual(["Did Mom nap today?"]);
		expect(bridgeCalls).toEqual([
			expect.objectContaining({
				family_id: "7",
				request: {
					tool: "health_samples",
					input: { metric: "sleep_hours", limit: 1 },
				},
			}),
		]);
		expect(geminiBodies[0]?.store).toBe(false);
		// The second request carries the model's steps unchanged, then the tool result.
		expect(geminiBodies[1]?.input.slice(1)).toEqual([
			...functionCall.steps,
			{
				type: "function_result",
				name: "health_samples",
				call_id: "call_1",
				result: [
					{ type: "text", text: expect.stringContaining('"value":7.5') },
				],
			},
		]);
	});

	test("records that are missing or old stay explicit", async () => {
		samples = [];
		const missing = Schema.decodeUnknownSync(FamilyAnswer)(
			await (await ask({ question: "Sleep?" })).json(),
		);
		expect(missing.unavailable).toEqual(["sleep_hours"]);
		samples = [sleepSample("2020-01-01T00:00:00.000Z")];
		const old = Schema.decodeUnknownSync(FamilyAnswer)(
			await (await ask({ question: "Sleep?" })).json(),
		);
		expect(old.evidence[0]?.stale).toBe(true);
	});

	test("without Gemini or Fetch.ai, nothing is answered or read", async () => {
		for (const configured of [
			{ gemini: false, fetch: true },
			{ gemini: true, fetch: false },
		]) {
			const response = await ask({ question: "Sleep?" }, mount(configured));
			expect(response.status).toBe(503);
			expect((await errorOf(response)).error).toBe("unavailable");
		}
		expect(bridgeCalls).toHaveLength(0);
	});

	test("invalid, failed, empty, or endless provider replies are upstream errors", async () => {
		const replies: Array<() => Response> = [
			() => new Response("quota detail", { status: 429 }),
			() => new Response("not json"),
			() => Response.json({ status: "completed", steps: "nope" }),
			() => Response.json(answer("   ")),
			// Plain text where the structured answer belongs.
			() =>
				Response.json({
					status: "completed",
					steps: [
						{
							type: "model_output",
							content: [{ type: "text", text: "Fine." }],
						},
					],
				}),
			() => Response.json({ status: "failed", steps: [] }),
			() => Response.json(functionCall),
		];
		for (const reply of replies) {
			gemini = reply;
			const response = await ask({ question: "Sleep?" });
			expect(response.status).toBe(502);
			expect((await errorOf(response)).message).not.toContain("quota detail");
		}
	});

	test("bad questions are rejected before any provider call", async () => {
		for (const body of [
			{},
			{ question: "  " },
			{ question: "Sleep?", timeZone: "Mars/Base" },
			{ question: "Sleep?", extra: true },
		])
			expect((await ask(body)).status).toBe(400);
		expect(geminiBodies).toHaveLength(0);
	});

	test("follow-ups are trimmed, 1 to 200 characters, distinct, and at most 3", async () => {
		answerWith([
			" Did Mom nap? ",
			"",
			"   ",
			"x".repeat(201),
			"y".repeat(200),
			"Did Mom nap?",
			"Bedtime?",
			"Steps today?",
		]);
		const reply = Schema.decodeUnknownSync(FamilyAnswer)(
			await (await ask({ question: "Sleep?" })).json(),
		);
		expect(reply.followUps).toEqual([
			"Did Mom nap?",
			"y".repeat(200),
			"Bedtime?",
		]);
	});

	test("follow-ups with a bad shape give none, and the answer stands", async () => {
		for (const followUps of [
			undefined,
			null,
			"Bedtime?",
			[1, "Bedtime?"],
			{ q: "Bedtime?" },
		]) {
			answerWith(followUps);
			const response = await ask({ question: "Sleep?" });
			expect(response.status).toBe(200);
			const reply = Schema.decodeUnknownSync(FamilyAnswer)(
				await response.json(),
			);
			expect(reply.answer).toBe("Mom slept 7.5 hours (synthetic).");
			expect(reply.followUps).toEqual([]);
		}
	});

	const MiB = 1024 * 1024;
	const file = (bytes: number, mimeType = "application/pdf") => ({
		name: "report.pdf",
		mimeType,
		data: Buffer.alloc(bytes, 97).toString("base64"),
	});

	test("files at the size limits are answered", async () => {
		for (const attachments of [
			[file(5 * MiB)],
			[file(4 * MiB), file(4 * MiB, "text/plain")],
		])
			expect((await ask({ question: "Sleep?", attachments })).status).toBe(200);
	});

	test("files over the limits are rejected before any provider call", async () => {
		const rejected: Array<[unknown[], string]> = [
			[[file(5 * MiB + 1)], "File 1 is larger than 5 MiB"],
			[[file(4 * MiB), file(4 * MiB + 1)], "8 MiB in total"],
			[[file(4.5 * MiB), file(4.5 * MiB)], "8 MiB of files at most"],
			[Array.from({ length: 5 }, () => file(1)), ""],
			[[file(1, "image/gif")], ""],
			[[{ ...file(1), data: "not base64!" }], ""],
			[[{ ...file(1), name: "" }], ""],
		];
		for (const [attachments, message] of rejected) {
			const response = await ask({ question: "Sleep?", attachments });
			expect(response.status).toBe(400);
			const error = await errorOf(response);
			expect(error.error).toBe("invalid_request");
			expect(error.message).toContain(message);
		}
		expect(geminiBodies).toHaveLength(0);
	});

	test("a client disconnect aborts the Gemini request", async () => {
		const aborted = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		gemini = (_body, request) => {
			request.signal.addEventListener("abort", () => aborted.resolve());
			started.resolve();
			return new Promise<Response>(() => {});
		};
		const cancel = new AbortController();
		const pending = ask({ question: "Sleep?" }, app, cancel.signal);
		await started.promise;
		cancel.abort();
		expect((await pending).status).toBe(499);
		// Hangs (and the test times out) if the provider request stays open.
		await aborted.promise;
	});
});

describe("POST /ask/voice", () => {
	const askVoice = () =>
		app.request("http://test/api/families/7/ask/voice?timeZone=Europe/Berlin", {
			method: "POST",
			headers: { "content-type": "audio/webm" },
			body: new Uint8Array([1, 2, 3]),
		});

	test("transcribes, answers, and speaks in the question's language", async () => {
		const response = await askVoice();
		expect(response.status).toBe(200);
		const reply = Schema.decodeUnknownSync(VoiceAnswer)(await response.json());
		expect(reply.transcript.text).toBe("How did Mom sleep?");
		expect(reply.answer.answer).toBe("Mom slept 7.5 hours (synthetic).");
		expect(reply.answer.followUps).toEqual(["Did Mom nap today?"]);
		expect(reply.speech).toEqual({
			status: "ok",
			languageCode: "en",
			audio: Buffer.from([0xff, 0xf3, 1, 2]).toString("base64"),
		});
		expect(geminiBodies[0]?.system_instruction).toContain("Europe/Berlin");
	});

	test("a speech failure keeps the text answer and says why", async () => {
		speech = () => new Response("detail", { status: 500 });
		const reply = Schema.decodeUnknownSync(VoiceAnswer)(
			await (await askVoice()).json(),
		);
		expect(reply.answer.answer).toBe("Mom slept 7.5 hours (synthetic).");
		expect(reply.speech.status).toBe("upstream_error");
	});
});
