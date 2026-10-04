import { expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";

import { phoneLine, wearableLine } from "./devices";

test("an unknown battery is not 0 %, and offline names what waits", () => {
	expect(phoneLine(true, null)).toEqual({
		text: "Phone online",
		detail: "Battery unknown",
	});
	expect(phoneLine(true, { level: 0, charging: true })).toEqual({
		text: "Phone online",
		detail: "Battery 0 %, charging",
	});
	expect(phoneLine(false, undefined)).toEqual({
		text: "Phone offline",
		detail: "Answers, directions, and messages wait. Battery: checking…",
	});
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

const connected = {
	sources: [
		{ source: "noop", status: "connected", lastSeenAt: "2026-10-04T11:00:00Z" },
	],
} as const;

test("a disconnected wearable shows only its last real reading, as saved", () => {
	const noop = {
		sources: [{ source: "noop", status: "not_connected", lastSeenAt: null }],
	} as const;
	expect(wearableLine(noop, [], now)).toEqual({
		text: "WHOOP not connected",
		detail: "No new readings; wear unknown.",
	});
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
	).toEqual({
		text: "WHOOP not connected",
		detail:
			"No new readings; wear unknown. Last reading 3 h ago. Saved, not current.",
	});
	expect(wearableLine(null, null, now)).toEqual({
		text: "WHOOP",
		detail: "Status unknown.",
	});
});

test("a connected wearable shows its reading age only once it is over an hour old", () => {
	expect(
		wearableLine(connected, [sample("noop:strap", false, 0.5)], now),
	).toEqual({ text: "WHOOP connected", detail: "Last reading 30 min ago." });
	expect(
		wearableLine(connected, [sample("noop:strap", false, 4)], now),
	).toEqual({ text: "WHOOP · 4 h ago", detail: "Last reading 4 h ago." });
	expect(wearableLine(connected, [], now)).toEqual({
		text: "WHOOP connected",
		detail: "No reading yet.",
	});
});
