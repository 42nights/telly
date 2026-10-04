import { describe, expect, test } from "bun:test";
import { ApiError, Sources } from "@health/contracts";
import { Exit, Schema } from "effect";
import { createApp } from "./app";

const app = createApp("http://localhost:3001");

// Excess keys fail decoding, so a reading or nudge added to a source cannot slip through unseen.
const strict = { onExcessProperty: "error" } as const;

describe("server boundaries", () => {
	test("Healer S.I. is reported unavailable, with no readings or nudges", async () => {
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

	test("clients reject a fabricated Healer S.I. reading", () => {
		const fabricated = {
			sources: [{ source: "noop", status: "connected", heartRate: 62 }],
		};
		expect(
			Exit.isFailure(Schema.decodeUnknownExit(Sources)(fabricated, strict)),
		).toBe(true);
	});

	test("unknown routes return the typed error body", async () => {
		const response = await app.request("/api/does-not-exist");
		expect(response.status).toBe(404);
		expect(
			Schema.decodeUnknownSync(ApiError)(await response.json()).error,
		).toBe("not_found");
	});
});
