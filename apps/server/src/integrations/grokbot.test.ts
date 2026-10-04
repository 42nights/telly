// Runs the adapter against a local HTTP server that speaks the xAI Responses API shape. This proves
// the tool loop and the error mapping, not a live xAI round trip.
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { askGrokbot, GrokbotError } from "./grokbot";

let replies: Array<{ status: number; body: unknown }> = [];
// What the adapter sent; the assertions below check its shape.
type Sent = { input: Array<Record<string, unknown>> } & Record<string, unknown>;
const requests: Array<{ authorization: string | null; body: Sent }> = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async (request) => {
		requests.push({
			authorization: request.headers.get("authorization"),
			body: (await request.json()) as Sent,
		});
		const next = replies.shift() ?? { status: 500, body: {} };
		return Response.json(next.body, { status: next.status });
	},
});
afterAll(() => server.stop(true));

const config = {
	apiKey: "test-key",
	model: "grok-test",
	baseUrl: `http://127.0.0.1:${server.port}`,
};
const call = (name: string, args: string) => ({
	status: 200,
	body: {
		status: "completed",
		model: "grok-test",
		output: [
			{ type: "reasoning", summary: [] },
			{ type: "function_call", call_id: "c1", name, arguments: args },
		],
	},
});
const text = (value: string, status = "completed") => ({
	status: 200,
	body: {
		status,
		model: "grok-test",
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: value }],
			},
		],
	},
});
const tools = [
	{
		name: "echo",
		description: "Echoes its arguments",
		parameters: { type: "object", properties: {} },
		run: (args: unknown) => Effect.succeed({ got: args }),
	},
	{
		name: "down",
		description: "Its data source is down",
		parameters: { type: "object", properties: {} },
		run: () => Effect.fail("source down"),
	},
];
const ask = async (...queued: typeof replies) => {
	replies = queued;
	requests.length = 0;
	return Effect.runPromiseExit(
		askGrokbot(config, { instructions: "be brief", question: "hi?", tools }),
	);
};
const failure = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit)
		? exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : r._tag))
		: [];

describe("Grokbot adapter (local protocol server)", () => {
	test("runs a requested tool and returns the model's final text", async () => {
		const exit = await ask(call("echo", '{"a":1}'), text("done"));
		expect(exit).toEqual(Exit.succeed({ text: "done", model: "grok-test" }));
		expect(requests[0]?.authorization).toBe("Bearer test-key");
		expect(requests[0]?.body).toMatchObject({
			model: "grok-test",
			store: false,
			instructions: "be brief",
		});
		// The second request replays the call and carries the tool's output for it.
		expect(requests[1]?.body.input.slice(1)).toEqual([
			{
				type: "function_call",
				call_id: "c1",
				name: "echo",
				arguments: '{"a":1}',
			},
			{
				type: "function_call_output",
				call_id: "c1",
				output: '{"got":{"a":1}}',
			},
		]);
	});

	test("unknown tools and malformed arguments go back to the model as errors", async () => {
		await ask(call("nope", "{}"), text("ok"));
		expect(requests[1]?.body.input.at(-1)?.output).toBe(
			'{"error":"unknown tool nope"}',
		);
		await ask(call("echo", "{"), text("ok"));
		expect(requests[1]?.body.input.at(-1)?.output).toBe(
			'{"error":"arguments are not valid JSON"}',
		);
	});

	test("provider failures stay explicit and never become an answer", async () => {
		expect(
			failure(await ask({ status: 429, body: { error: "slow down" } })),
		).toEqual([new GrokbotError({ reason: "http", status: 429 })]);
		expect(
			failure(await ask({ status: 200, body: { output: "nope" } })),
		).toEqual([new GrokbotError({ reason: "invalid_response" })]);
		expect(failure(await ask(text("   ")))).toEqual([
			new GrokbotError({ reason: "invalid_response" }),
		]);
		expect(failure(await ask(text("partial", "incomplete")))).toEqual([
			new GrokbotError({ reason: "incomplete" }),
		]);
		const loop = call("echo", "{}");
		expect(failure(await ask(loop, loop, loop, loop))).toEqual([
			new GrokbotError({ reason: "turn_limit" }),
		]);
	});

	test("a failing tool ends the answer with its error", async () => {
		expect(failure(await ask(call("down", "{}"), text("ok")))).toEqual([
			"source down",
		]);
	});

	test("an unreachable provider is a network failure", async () => {
		const exit = await Effect.runPromiseExit(
			askGrokbot(
				{ ...config, baseUrl: "http://127.0.0.1:9" },
				{ instructions: "", question: "hi?", tools: [] },
			),
		);
		expect(failure(exit)).toEqual([new GrokbotError({ reason: "network" })]);
	});
});
