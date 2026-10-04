import { expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";

import { phoneLine, wearableLine } from "./devices";

test("an unknown battery is not 0 %, and offline names what waits", () => {
	expect(phoneLine(true, null)).toBe("This phone · online · battery unknown");
	expect(phoneLine(true, { level: 0, charging: true })).toBe(
		"This phone · online · battery 0 % · charging",
	);
	expect(phoneLine(false, undefined)).toBe(
		"This phone · offline · answers, directions, and messages wait · battery: checking…",
	);
});

const now = Date.parse("2026-10-04T12:00:00Z");
const sample = (source: string, synthetic: boolean, hoursAgo: number) =>
	({
		id: source,
		familyId: "1",
		metric: "heart_rate",
		value: 60,
		unit: "bpm",
		sourceTime: new Date(now - hoursAgo * 3_600_000).toISOString(),
		receivedAt: new Date(now).toISOString(),
		source,
		synthetic,
		quality: "unvalidated",
	}) satisfies HealthSample;

test("a disconnected wearable shows only its last real reading, as saved", () => {
	const noop = {
		sources: [{ source: "noop", status: "not_connected" }],
	} as const;
	expect(wearableLine(noop, [], now)).toBe(
		"WHOOP · not connected · no new readings · wear unknown · last contact unknown",
	);
	expect(
		wearableLine(
			noop,
			[
				sample("noop:strap", false, 3),
				sample("noop:strap", true, 0),
				sample("phone", false, 1),
			],
			now,
		),
	).toBe(
		"WHOOP · not connected · no new readings · wear unknown · last reading 3 h ago · saved, not current",
	);
	expect(wearableLine(null, null, now)).toBe(
		"WHOOP · status unknown · last contact unknown",
	);
});
