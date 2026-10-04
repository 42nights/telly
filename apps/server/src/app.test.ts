import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { ApiError, Sources } from "@health/contracts";
import { Exit, Schema } from "effect";
import { createApp } from "./app";
import type { NoopSample } from "./integrations/noop-ingest";

// Sign-in is not configured, as in a fresh checkout.
const config = {
	corsOrigin: "http://localhost:3001",
	auth: undefined,
	voice: {
		apiKey: undefined,
		voiceId: "unused",
		baseUrl: "http://127.0.0.1:1",
	},
};
const app = createApp(config);

// Excess keys fail decoding, so a reading or nudge added to a source cannot slip through unseen.
const strict = { onExcessProperty: "error" } as const;

describe("server boundaries", () => {
	test("NOOP is reported unavailable, with no readings or nudges", async () => {
		const response = await app.request("/api/sources");
		expect(response.status).toBe(200);
		const { sources } = Schema.decodeUnknownSync(Sources)(
			await response.json(),
			strict,
		);
		expect(sources.find((s) => s.source === "noop")?.status).toBe(
			"not_connected",
		);
	});

	test("clients reject a fabricated NOOP reading", () => {
		const fabricated = {
			sources: [{ source: "noop", status: "connected", heartRate: 62 }],
		};
		expect(
			Exit.isFailure(Schema.decodeUnknownExit(Sources)(fabricated, strict)),
		).toBe(true);
	});

	test("NOOP ingest records only an authorised, well-formed relay batch", async () => {
		const recorded: NoopSample[][] = [];
		const ingest = createApp(config, {
			key: "relay-key",
			record: async (samples) => {
				recorded.push([...samples]);
			},
		});
		const minute = 1_789_999_980;
		const day = Date.parse("2026-10-03T00:00:00Z");
		const batch = deflateRawSync(
			JSON.stringify({
				tables: {
					hrSample: [
						{ deviceId: "my-whoop", ts: minute, bpm: 61 },
						{ deviceId: "my-whoop", ts: minute + 30, bpm: 64 },
						{ deviceId: "my-whoop", ts: minute + 60, bpm: 70 },
					],
					event: [
						{ deviceId: "my-whoop", ts: minute + 5, kind: "WRIST_OFF(10)" },
						{ deviceId: "my-whoop", ts: minute + 6, kind: "DOUBLE_TAP(14)" },
					],
					dailyMetric: [
						{
							deviceId: "my-whoop-noop",
							day: "2026-10-03",
							restingHr: 52,
							avgHrv: null,
							efficiency: 0.5,
							strain: 29.6,
						},
						{ deviceId: "apple-health", day: "2026-10-03", steps: 9000 },
					],
					gravitySample: [{ deviceId: "my-whoop", ts: minute, x: 0.1 }],
				},
			}),
		);
		const post = (
			target: typeof app,
			query: string,
			body: Uint8Array | string,
		) => target.request(`/api/noop/ingest${query}`, { method: "POST", body });
		const fractionalTs = deflateRawSync(
			JSON.stringify({
				tables: { hrSample: [{ deviceId: "my-whoop", ts: 1.5, bpm: 60 }] },
			}),
		);

		expect((await post(app, "?k=relay-key", batch)).status).toBe(503);
		expect((await post(ingest, "?k=wrong", batch)).status).toBe(401);
		expect((await post(ingest, "", batch)).status).toBe(401);
		expect((await post(ingest, "?k=relay-key", "not deflate")).status).toBe(
			400,
		);
		expect((await post(ingest, "?k=relay-key", fractionalTs)).status).toBe(400);
		expect(recorded).toEqual([]);

		expect((await post(ingest, "?k=relay-key", batch)).status).toBe(204);
		const sample = (
			metric: string,
			value: number,
			unit: string,
			time: number,
			source: string,
		) => ({ metric, value, unit, time, source });
		expect(recorded).toEqual([
			[
				sample("heart_rate", 61, "bpm", minute * 1000, "noop:my-whoop"),
				sample("heart_rate", 70, "bpm", (minute + 60) * 1000, "noop:my-whoop"),
				sample("on_wrist", 0, "boolean", (minute + 5) * 1000, "noop:my-whoop"),
				sample("resting_heart_rate", 52, "bpm", day, "noop:my-whoop-noop"),
				sample("sleep_efficiency", 50, "%", day, "noop:my-whoop-noop"),
				sample(
					"daily_strain",
					29.6,
					"noop effort (0-100)",
					day,
					"noop:my-whoop-noop",
				),
			],
		]);
	});

	test("unknown routes return the typed error body", async () => {
		const response = await app.request("/does-not-exist");
		expect(response.status).toBe(404);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("not_found");
	});

	test("without sign-in configuration, protected routes are unavailable, not open", async () => {
		const response = await app.request("/api/families/1", {
			headers: { Authorization: "Bearer anything" },
		});
		expect(response.status).toBe(503);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("unavailable");
	});
});
