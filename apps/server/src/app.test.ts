import { describe, expect, spyOn, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { ApiError, Sources } from "@health/contracts";
import { Exit, Schema } from "effect";
import { createApp } from "./app";
import { serverConfig } from "./config";
import { DbUnavailable } from "./db";
import { sha256Hex } from "./http";
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
		const recorded: [bigint, NoopSample[]][] = [];
		const ingest = createApp(config, {
			identity: "0".repeat(64),
			legacy: { key: "relay-key", familyId: 7n },
			tokenFamily: (hash) =>
				hash === sha256Hex("family-token") ? 9n : undefined,
			record: async (familyId, samples) => {
				recorded.push([familyId, [...samples]]);
			},
		});
		const minute = 1_789_999_980;
		const day = Date.parse("2026-10-03T00:00:00Z");
		const batch = deflateRawSync(
			JSON.stringify({
				tables: {
					hrSample: [
						{ deviceId: "my-whoop", ts: minute, bpm: 61 },
						{ deviceId: "my-whoop", ts: minute + 10, bpm: 64 },
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
			authorization?: string,
		) =>
			target.request(`/api/noop/ingest${query}`, {
				method: "POST",
				body,
				headers: authorization ? { Authorization: authorization } : {},
			});
		const fractionalTs = deflateRawSync(
			JSON.stringify({
				tables: { hrSample: [{ deviceId: "my-whoop", ts: 1.5, bpm: 60 }] },
			}),
		);

		expect((await post(app, "?k=relay-key", batch)).status).toBe(503);
		expect((await post(ingest, "?k=wrong", batch)).status).toBe(401);
		expect((await post(ingest, "", batch)).status).toBe(401);
		expect((await post(ingest, "", batch, "Bearer wrong")).status).toBe(401);
		expect((await post(ingest, "?k=relay-key", "not deflate")).status).toBe(
			400,
		);
		expect((await post(ingest, "?k=relay-key", fractionalTs)).status).toBe(400);
		expect(recorded).toEqual([]);
		const noopStatus = async () =>
			Schema.decodeUnknownSync(Sources)(
				await (await ingest.request("/api/sources")).json(),
				strict,
			).sources[0];
		expect((await noopStatus())?.status).toBe("not_connected");

		expect((await post(ingest, "?k=relay-key", batch)).status).toBe(200);
		expect(await noopStatus()).toMatchObject({
			source: "noop",
			status: "connected",
			lastSeenAt: expect.any(String),
		});
		const sample = (
			metric: string,
			value: number,
			unit: string,
			time: number,
			source: string,
		) => ({ metric, value, unit, time, source });
		expect(recorded).toEqual([
			[
				7n,
				[
					sample(
						"heart_rate",
						64,
						"bpm",
						(minute + 10) * 1000,
						"noop:my-whoop",
					),
					sample(
						"heart_rate",
						70,
						"bpm",
						(minute + 60) * 1000,
						"noop:my-whoop",
					),
					sample(
						"on_wrist",
						0,
						"boolean",
						(minute + 5) * 1000,
						"noop:my-whoop",
					),
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
			],
		]);
		recorded.length = 0;
		expect((await post(ingest, "", batch, "Bearer relay-key")).status).toBe(
			200,
		);
		expect(recorded.map(([familyId]) => familyId)).toEqual([7n]);

		// A family push token (NOOP sends only the URL) records into that token's family.
		recorded.length = 0;
		expect((await post(ingest, "?k=family-token", batch)).status).toBe(200);
		expect((await post(ingest, "?k=other-token", batch)).status).toBe(401);
		expect(recorded.map(([familyId]) => familyId)).toEqual([9n]);
	});

	test("WHOOP push needs only the NOOP token; the legacy key and family stay a pair", () => {
		const db = { uri: "ws://127.0.0.1:1", database: "health" };
		const env = {
			CORS_ORIGIN: "http://localhost:3001",
			ELEVENLABS_VOICE_ID: "voice",
			ELEVENLABS_API_URL: "http://127.0.0.1:1",
			GEMINI_BASE_URL: "http://127.0.0.1:1",
			REPORT_EMAIL_FROM: "Telly <reports@example.com>",
			SPACETIMEDB_URI: db.uri,
			SPACETIMEDB_DATABASE: db.database,
			NOOP_SPACETIMEDB_TOKEN: "ingest-token",
		};
		expect(serverConfig(env).noop).toEqual({
			db: { ...db, token: "ingest-token" },
		});
		expect(
			serverConfig({ ...env, NOOP_INGEST_KEY: "k", NOOP_FAMILY_ID: "3" }).noop
				?.legacy,
		).toEqual({ key: "k", familyId: 3n });
		expect(() => serverConfig({ ...env, NOOP_INGEST_KEY: "k" })).toThrow();
		expect(() =>
			serverConfig({
				...env,
				NOOP_SPACETIMEDB_TOKEN: undefined,
				NOOP_INGEST_KEY: "k",
				NOOP_FAMILY_ID: "3",
			}),
		).toThrow();
	});

	test("the request log never prints the NOOP ingest key", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			await app.request("/api/noop/ingest?x=1&k=relay-key", {
				method: "POST",
			});
			const lines = log.mock.calls.flat().join("\n");
			expect(lines).toContain("/api/noop/ingest?x=1&k=***");
			expect(lines).not.toContain("relay-key");
		} finally {
			log.mockRestore();
		}
	});

	test("unknown routes return the typed error body", async () => {
		const response = await app.request("/does-not-exist");
		expect(response.status).toBe(404);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("not_found");
	});

	test("an unexpected failure answers a generic 500 and logs it, unless the client left", async () => {
		const failing = createApp(config, {
			identity: "0".repeat(64),
			legacy: { key: "relay-key", familyId: 7n },
			tokenFamily: () => undefined,
			record: async () => {
				throw new Error("row 7 of family 42 is corrupt");
			},
		});
		const batch = deflateRawSync(JSON.stringify({ tables: {} }));
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await failing.request("/api/noop/ingest", {
				method: "POST",
				body: batch,
				headers: { Authorization: "Bearer relay-key" },
			});
			expect(response.status).toBe(500);
			expect(
				Schema.decodeUnknownSync(ApiError)(await response.json(), strict),
			).toEqual({ error: "internal", message: "Internal server error" });
			expect(errors).toHaveBeenCalledTimes(1);

			const gone = new AbortController();
			gone.abort();
			const cancelled = await failing.request(
				new Request("http://localhost/api/noop/ingest", {
					method: "POST",
					body: batch,
					headers: { Authorization: "Bearer relay-key" },
					signal: gone.signal,
				}),
			);
			expect(cancelled.status).toBe(500);
			expect(errors).toHaveBeenCalledTimes(1);
		} finally {
			errors.mockRestore();
		}
	});

	test("a closed database connection reads as an outage, not a server bug", async () => {
		const outage = createApp(config, {
			identity: "0".repeat(64),
			legacy: { key: "relay-key", familyId: 7n },
			tokenFamily: () => undefined,
			record: async () => {
				throw new DbUnavailable({ reason: "connection closed" });
			},
		});
		const response = await outage.request("/api/noop/ingest", {
			method: "POST",
			body: deflateRawSync(JSON.stringify({ tables: {} })),
			headers: { Authorization: "Bearer relay-key" },
		});
		expect(response.status).toBe(503);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json(), strict).error,
		).toBe("unavailable");
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

	test("each listed CORS origin is allowed, and no other", async () => {
		const app = createApp(
			serverConfig({
				CORS_ORIGIN:
					"https://app.saintess.tech,https://telly.example.workers.dev",
				ELEVENLABS_VOICE_ID: "voice",
				ELEVENLABS_API_URL: "http://127.0.0.1:1",
				GEMINI_BASE_URL: "http://127.0.0.1:1",
				REPORT_EMAIL_FROM: "Telly <reports@saintess.tech>",
			}),
		);
		const allowed = async (origin: string) =>
			(
				await app.request("/health", { headers: { Origin: origin } })
			).headers.get("Access-Control-Allow-Origin");
		expect(await allowed("https://app.saintess.tech")).toBe(
			"https://app.saintess.tech",
		);
		expect(await allowed("https://telly.example.workers.dev")).toBe(
			"https://telly.example.workers.dev",
		);
		expect(await allowed("https://evil.test")).toBeNull();
	});
});
