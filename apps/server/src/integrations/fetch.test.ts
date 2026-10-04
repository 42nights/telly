import { afterAll, describe, expect, test } from "bun:test";
import type { ToolRequest } from "@health/contracts/tools";
import { callAgentTool } from "./fetch";

// Test-only stand-in for the local bridge uAgent: it answers each call with the next queued reply.
let reply: () => Response = () => Response.json({});
let received: unknown;
const bridge = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		received = await request.json();
		return reply();
	},
});
afterAll(() => bridge.stop(true));

const config = { bridgeUrl: bridge.url.href, bridgeToken: "test-token" };
const request: ToolRequest = { tool: "alerts", input: { limit: 5 } };
const ok = { tool: "alerts", alerts: [], acknowledgements: [] } as const;
const envelope =
	(status: number, body: unknown, family_id = "7") =>
	() =>
		Response.json({ family_id, status, body });

const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: { name: string; code: string }) => [error.name, error.code],
	);

describe("callAgentTool", () => {
	test("unconfigured is unavailable", async () => {
		expect(await failure(callAgentTool(undefined, 7n, request))).toEqual([
			"ApiFailure",
			"unavailable",
		]);
	});

	test("a tool result passes through; the bridge gets the token, family, and request", async () => {
		reply = envelope(200, ok);
		expect(await callAgentTool(config, 7n, request)).toEqual(ok);
		expect(received).toEqual({ token: "test-token", family_id: "7", request });
	});

	test("a tool ApiError becomes that ApiFailure", async () => {
		reply = envelope(403, { error: "forbidden", message: "not a member" });
		expect(await failure(callAgentTool(config, 7n, request))).toEqual([
			"ApiFailure",
			"forbidden",
		]);
	});

	for (const [name, bad] of [
		["another family", envelope(200, ok, "8")],
		["another tool", envelope(200, { tool: "health_samples", samples: [] })],
		["a malformed result", envelope(200, { tool: "alerts" })],
		["a malformed error", envelope(500, { oops: true })],
		["a non-JSON body", () => new Response("not json")],
		["a bridge fault", () => Response.json({ detail: "bad" }, { status: 400 })],
	] as const)
		test(`${name} is upstream_error`, async () => {
			reply = bad;
			expect(await failure(callAgentTool(config, "7", request))).toEqual([
				"ApiFailure",
				"upstream_error",
			]);
		});

	test("an unreachable bridge is unavailable", async () => {
		const closed = { ...config, bridgeUrl: "http://127.0.0.1:1" };
		expect(await failure(callAgentTool(closed, 7n, request))).toEqual([
			"ApiFailure",
			"unavailable",
		]);
	});

	test("a caller abort rejects as unavailable", async () => {
		reply = envelope(200, ok);
		expect(
			await failure(callAgentTool(config, 7n, request, AbortSignal.abort())),
		).toEqual(["ApiFailure", "unavailable"]);
	});
});
