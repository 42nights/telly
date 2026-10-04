// A local protocol server stands in for the Gemini Interactions API, and an in-memory `run` for
// the family tools. Test key and synthetic records only: local protocol proof, not live Gemini.
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Effect, Exit } from "effect";
import { ApiFailure } from "../http";
import { askGemini } from "./gemini-chat";

type Body = {
	model: string;
	store: boolean;
	system_instruction: string;
	input: unknown[];
	tools: unknown[];
	response_format: { schema: { required: string[] } };
};
const bodies: Body[] = [];
const keys: (string | null)[] = [];
let reply: (body: Body, request: Request) => Response | Promise<Response>;
const server = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const body = (await request.json()) as Body;
		bodies.push(body);
		keys.push(request.headers.get("x-goog-api-key"));
		return reply(body, request);
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	bodies.length = 0;
	keys.length = 0;
});

const config = { apiKey: "test-gemini-key", baseUrl: server.url.origin };

const answer = (value: unknown, model?: string) =>
	Response.json({
		status: "completed",
		...(model === undefined ? {} : { model }),
		steps: [
			{ type: "thought", signature: "s" },
			{
				type: "model_output",
				content: [
					{
						type: "text",
						text: typeof value === "string" ? value : JSON.stringify(value),
					},
				],
			},
		],
	});
const toolCall = (id: string, name: string, args?: unknown) => ({
	type: "function_call",
	id,
	name,
	...(args === undefined ? {} : { arguments: args }),
});
const requiresAction = (...steps: unknown[]) =>
	Response.json({ status: "requires_action", steps });

const runs: { name: string; args: unknown }[] = [];
const family = {
	rules: "Answer only from the family records.",
	tools: [
		{
			name: "get_sleep",
			description: "Sleep records",
			parameters: { type: "object" },
		},
	],
	run: async (name: string, args: unknown) => {
		runs.push({ name, args });
		return { hours: 7.5, name };
	},
};
beforeEach(() => {
	runs.length = 0;
});

const ask = (
	question = "How did Mom sleep?",
	attachments: Parameters<typeof askGemini>[1]["attachments"] = [],
	tools: Parameters<typeof askGemini>[2] = family,
) => askGemini(config, { question, attachments }, tools);
const failure = (effect = ask()) => Effect.runPromise(Effect.flip(effect));

describe("askGemini", () => {
	test("without configuration it is unavailable and calls no provider", async () => {
		const error = await failure(
			askGemini(undefined, { question: "Hi" }, family),
		);
		expect(error).toMatchObject({
			_tag: "GeminiChatError",
			reason: "unavailable",
		});
		expect(bodies).toHaveLength(0);
	});

	test("sends the question, files, rules, and tools statelessly and reads the answer", async () => {
		reply = () =>
			answer(
				{ answer: "  Mom slept 7.5 hours.  ", follow_ups: ["Why?"] },
				"gemini-3.8-flash",
			);
		const result = await Effect.runPromise(
			ask("What does this say?", [
				{ name: "lab.pdf", mimeType: "application/pdf", data: "JVBERg==" },
				{
					name: "note.txt",
					mimeType: "text/plain",
					data: Buffer.from("Take with food").toString("base64"),
				},
				{ name: "box.png", mimeType: "image/png", data: "iVBORw0KGgo=" },
			]),
		);
		expect(result).toEqual({
			text: "Mom slept 7.5 hours.",
			model: "gemini-3.8-flash",
			followUps: ["Why?"],
		});
		expect(keys).toEqual(["test-gemini-key"]);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			model: "gemini-3.8-flash",
			store: false,
			system_instruction: family.rules,
			tools: [
				{
					type: "function",
					name: "get_sleep",
					description: "Sleep records",
					parameters: { type: "object" },
				},
			],
			response_format: { schema: { required: ["answer", "follow_ups"] } },
			input: [
				{
					type: "user_input",
					content: [
						{
							type: "document",
							mime_type: "application/pdf",
							data: "JVBERg==",
						},
						{ type: "text", text: 'File "note.txt":\nTake with food' },
						{ type: "image", mime_type: "image/png", data: "iVBORw0KGgo=" },
						{ type: "text", text: "What does this say?" },
					],
				},
			],
		});
	});

	test("without a model in the reply, the pinned chat model is reported", async () => {
		reply = () => answer({ answer: "Fine.", follow_ups: [] });
		expect((await Effect.runPromise(ask())).model).toBe("gemini-3.8-flash");
	});

	test.each<[string, unknown, string[]]>([
		[
			"trimmed, de-duplicated, at most 3, each 1 to 200 characters",
			["  A? ", "A?", "", "   ", "x".repeat(201), "B?", "C?", "D?"],
			["A?", "B?", "C?"],
		],
		["not a list", "Ask more", []],
		["a list with a non-string", ["A?", 3], []],
		["missing", undefined, []],
	])("follow-ups %s", async (_, followUps, expected) => {
		reply = () => answer({ answer: "Fine.", follow_ups: followUps });
		expect((await Effect.runPromise(ask())).followUps).toEqual(expected);
	});

	test("runs each called tool in order and sends the results back with the history", async () => {
		const calls = [
			toolCall("call-1", "get_sleep", { days: 1 }),
			toolCall("call-2", "get_sleep"),
		];
		reply = (body) =>
			body.input.length === 1
				? requiresAction({ type: "thought", signature: "t" }, ...calls)
				: answer({ answer: "Mom slept 7.5 hours.", follow_ups: [] });
		const result = await Effect.runPromise(ask());
		expect(result.text).toBe("Mom slept 7.5 hours.");
		expect(runs).toEqual([
			{ name: "get_sleep", args: { days: 1 } },
			{ name: "get_sleep", args: {} },
		]);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]?.input.slice(1)).toEqual([
			{ type: "thought", signature: "t" },
			...calls,
			{
				type: "function_result",
				name: "get_sleep",
				call_id: "call-1",
				result: [
					{
						type: "text",
						text: JSON.stringify({ hours: 7.5, name: "get_sleep" }),
					},
				],
			},
			{
				type: "function_result",
				name: "get_sleep",
				call_id: "call-2",
				result: [
					{
						type: "text",
						text: JSON.stringify({ hours: 7.5, name: "get_sleep" }),
					},
				],
			},
		]);
	});

	test("a tool's ApiFailure stops the answer with that failure", async () => {
		reply = () => requiresAction(toolCall("c", "get_sleep"));
		const denied = new ApiFailure("forbidden", "Not your family");
		const error = await failure(
			ask("Q", [], {
				...family,
				run: () => Promise.reject(denied),
			}),
		);
		expect(error).toBe(denied);
		expect(bodies).toHaveLength(1);
	});

	test("any other tool error stops the answer as an upstream_error", async () => {
		reply = () => requiresAction(toolCall("c", "get_sleep"));
		const error = await failure(
			ask("Q", [], {
				...family,
				run: () => Promise.reject(new Error("bridge secret detail")),
			}),
		);
		expect(error).toBeInstanceOf(ApiFailure);
		expect(error).toMatchObject({
			code: "upstream_error",
			message: "A family tool failed",
		});
	});

	test("a model that keeps calling tools fails after the round limit", async () => {
		reply = () => requiresAction(toolCall("c", "get_sleep"));
		const error = await failure();
		expect(error).toMatchObject({
			_tag: "GeminiChatError",
			reason: "upstream_error",
		});
		expect(error.message).toContain("still called tools");
		// The first call plus 4 tool rounds.
		expect(bodies).toHaveLength(5);
		expect(runs).toHaveLength(5);
	});

	test.each<[string, () => Response, string]>([
		["a non-JSON reply", () => new Response("<html>"), "invalid reply"],
		[
			"a reply outside the schema",
			() => Response.json({ steps: [] }),
			"invalid reply",
		],
		[
			"a step without a type",
			() => Response.json({ status: "completed", steps: [{ id: 1 }] }),
			"invalid reply",
		],
		[
			"a failed interaction",
			() => Response.json({ status: "failed", steps: [] }),
			"did not complete",
		],
		[
			"requires_action without a call",
			() => requiresAction({ type: "thought" }),
			"did not complete",
		],
		[
			"answer text that is not JSON",
			() => answer("Mom slept well."),
			"invalid answer",
		],
		[
			"an answer without the answer field",
			() => answer({ follow_ups: [] }),
			"invalid answer",
		],
		[
			"a blank answer",
			() => answer({ answer: "   ", follow_ups: ["A?"] }),
			"empty answer",
		],
		[
			"no model output",
			() => Response.json({ status: "completed", steps: [] }),
			"invalid answer",
		],
	])(
		"%s is an upstream_error naming the failed step",
		async (_, make, message) => {
			reply = make;
			const error = await failure();
			expect(error).toMatchObject({
				_tag: "GeminiChatError",
				reason: "upstream_error",
			});
			expect(error.message).toContain(message);
		},
	);

	test.each([400, 401, 500])(
		"HTTP %i is an upstream_error with the status and no provider text",
		async (status) => {
			reply = () => new Response("detail test-gemini-key", { status });
			const error = await failure();
			expect(error).toMatchObject({
				_tag: "GeminiChatError",
				reason: "upstream_error",
			});
			expect(error.message).toContain(`HTTP ${status}`);
			expect(error.message).not.toContain("detail");
			expect(error.message).not.toContain("test-gemini-key");
			expect(bodies).toHaveLength(1);
		},
	);

	test.each([429, 503])(
		"an overloaded primary (HTTP %i) is answered by the fallback model",
		async (status) => {
			reply = (body) =>
				body.model === "gemini-3.8-flash"
					? new Response("high demand", { status })
					: answer({ answer: "Fine.", follow_ups: [] }, body.model);
			const result = await Effect.runPromise(ask());
			expect(result).toEqual({
				text: "Fine.",
				model: "gemini-3.5-flash",
				followUps: [],
			});
			expect(bodies.map(({ model }) => model)).toEqual([
				"gemini-3.8-flash",
				"gemini-3.5-flash",
			]);
		},
	);

	test("an unreachable provider is an upstream_error", async () => {
		const baseUrl = "http://127.0.0.1:1";
		const error = await failure(
			askGemini({ ...config, baseUrl }, { question: "Q" }, family),
		);
		expect(error).toMatchObject({
			_tag: "GeminiChatError",
			reason: "upstream_error",
			message: "Gemini could not be reached",
		});
	});

	test("a provider that never answers fails as an upstream_error and is aborted", async () => {
		// Shortens the 30 s provider limit; the adapter's own timeout path still runs.
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const short = spyOn(AbortSignal, "timeout").mockImplementation(() =>
			timeout(50),
		);
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		reply = (_, request) => {
			request.signal.addEventListener("abort", () => resolve());
			return new Promise<Response>(() => {});
		};
		try {
			const error = await failure();
			expect(error).toMatchObject({
				_tag: "GeminiChatError",
				reason: "upstream_error",
			});
			expect(error.message).not.toContain("could not be reached");
			await aborted;
		} finally {
			short.mockRestore();
		}
	});

	test("interrupting the question aborts the provider call", async () => {
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		const { promise: closed, resolve: close } = Promise.withResolvers<void>();
		reply = (_, request) => {
			request.signal.addEventListener("abort", () => close());
			arrive();
			return new Promise<Response>(() => {});
		};
		const controller = new AbortController();
		const run = Effect.runPromiseExit(ask(), { signal: controller.signal });
		await arrived;
		controller.abort();
		expect(Exit.isFailure(await run)).toBe(true);
		await closed;
	});
});
