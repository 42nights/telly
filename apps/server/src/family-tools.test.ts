// Runs the family tools against a local stand-in for the Fetch.ai bridge (`POST /tool-call`). This
// proves argument checks, cited records, and failure handling, not a live Agentverse round trip.
import { afterAll, describe, expect, test } from "bun:test";
import { familyTools } from "./family-tools";
import { ApiFailure } from "./http";

const sample = (id: string, metric: string, sourceTime: string) => ({
	id,
	familyId: "7",
	metric,
	value: 6.7,
	unit: "h",
	sourceTime,
	receivedAt: sourceTime,
	source: "synthetic-demo",
	synthetic: true,
	quality: "unvalidated",
});

let reply: (request: { tool: string; input: { metric?: string } }) => {
	status: number;
	body: unknown;
};
const sent: Array<unknown> = [];
const bridge = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (http) => {
		const call = (await http.json()) as {
			family_id: string;
			request: { tool: string; input: { metric?: string } };
		};
		sent.push(call.request);
		return Response.json({ family_id: call.family_id, ...reply(call.request) });
	},
});
afterAll(() => bridge.stop(true));
const fetchAgent = {
	bridgeUrl: `http://127.0.0.1:${bridge.port}`,
	bridgeToken: "test-token",
};
const now = new Date("2026-01-02T12:00:00.000Z");

describe("family tools (local Fetch.ai bridge stand-in)", () => {
	test("offers the closed tool set as JSON Schema functions", () => {
		const { tools } = familyTools(fetchAgent, 7n, now);
		expect(tools.map((t) => t.name)).toEqual(["health_samples", "alerts"]);
		for (const tool of tools) expect(tool.parameters.type).toBe("object");
	});

	test("cites returned samples with freshness and names metrics with no records", async () => {
		reply = ({ input }) => ({
			status: 200,
			body: {
				tool: "health_samples",
				samples:
					input.metric === "sleep_hours"
						? [
								sample("1", "sleep_hours", "2026-01-02T07:00:00.000Z"),
								sample("2", "sleep_hours", "2025-12-30T07:00:00.000Z"),
							]
						: [],
			},
		});
		const family = familyTools(fetchAgent, 7n, now);
		await family.run("health_samples", { metric: "sleep_hours" });
		await family.run("health_samples", { metric: "breathing_rate" });
		const { evidence, unavailable } = family.cited();
		expect(evidence.map((e) => [e.id, e.stale])).toEqual([
			["1", false],
			["2", true],
		]);
		expect(unavailable).toEqual(["breathing_rate"]);
	});

	test("bad arguments go back to the model without a Fetch.ai call", async () => {
		sent.length = 0;
		const family = familyTools(fetchAgent, 7n, now);
		for (const [name, args] of [
			["run_sql", {}],
			["health_samples", { limit: 0 }],
			["alerts", { familyId: "8" }],
		] as const)
			expect(await family.run(name, args)).toEqual({
				error: `${name} is not a tool, or its arguments do not match`,
			});
		expect(sent).toEqual([]);
	});

	test("a Fetch.ai failure stops the answer instead of continuing without data", async () => {
		reply = () => ({
			status: 403,
			body: { error: "forbidden", message: "no grant for this family" },
		});
		const denied = familyTools(fetchAgent, 7n, now).run("alerts", {});
		await expect(denied).rejects.toEqual(
			new ApiFailure("forbidden", "no grant for this family"),
		);
		const unconfigured = familyTools(undefined, 7n, now).run("alerts", {});
		await expect(unconfigured).rejects.toBeInstanceOf(ApiFailure);
	});
});
