import { describe, expect, test } from "bun:test";
import { ApiError, Sources } from "@health/contracts";
import { Exit, Schema } from "effect";
import { createApp } from "./app";
import { serverConfig } from "./config";

// Sign-in is not configured, as in a fresh checkout.
const app = createApp({
	corsOrigin: "http://localhost:3001",
	auth: undefined,
	voice: {
		apiKey: undefined,
		voiceId: "unused",
		baseUrl: "http://127.0.0.1:1",
	},
});

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

	test("each listed CORS origin is allowed, and no other", async () => {
		const app = createApp(
			serverConfig({
				CORS_ORIGIN:
					"https://app.saintess.tech,https://telly.example.workers.dev",
				ELEVENLABS_VOICE_ID: "voice",
				ELEVENLABS_API_URL: "http://127.0.0.1:1",
				GEMINI_BASE_URL: "http://127.0.0.1:1",
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
