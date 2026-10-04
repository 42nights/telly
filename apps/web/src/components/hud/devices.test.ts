import { expect, test } from "bun:test";

import { phoneLine, wearableLine } from "./devices";

test("an unknown battery is not 0 %, and offline names what waits", () => {
	expect(phoneLine(true, null)).toEqual({
		text: "Phone online",
		detail: "Online. Battery unknown.",
		state: "ok",
	});
	expect(phoneLine(true, { level: 0, charging: true })).toEqual({
		text: "Phone 0 %",
		detail: "Online. Battery 0 %, charging.",
		state: "ok",
	});
	expect(phoneLine(false, undefined)).toEqual({
		text: "Phone offline",
		detail:
			"Offline: answers, directions, and messages wait. Battery: checking…",
		state: "bad",
	});
});

const now = Date.parse("2026-10-04T12:00:00Z");
const noop = (
	status: "connected" | "not_connected",
	hoursAgo: number | null,
) => ({
	sources: [
		{
			source: "noop" as const,
			status,
			lastSeenAt:
				hoursAgo === null
					? null
					: new Date(now - hoursAgo * 3_600_000).toISOString(),
		},
	],
});

test("the WHOOP pane says how old the last reading is, and never that it is worn", () => {
	expect(wearableLine(null, now)).toEqual({
		text: "WHOOP",
		detail: "Status unknown.",
		state: "unknown",
	});
	expect(wearableLine({ sources: [] }, now).text).toBe("WHOOP not set up");
	expect(wearableLine(noop("not_connected", null), now)).toEqual({
		text: "WHOOP off",
		detail: "No reading yet.",
		state: "bad",
	});
	expect(wearableLine(noop("not_connected", 5), now)).toEqual({
		text: "WHOOP 5 h ago",
		detail:
			"Not connected: no new readings, wear unknown. Last reading 5 h ago.",
		state: "warn",
	});
	expect(wearableLine(noop("connected", 0.05), now)).toEqual({
		text: "WHOOP online",
		detail: "Connected. Last reading 3 min ago.",
		state: "ok",
	});
});
