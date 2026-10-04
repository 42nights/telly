import { describe, expect, test } from "bun:test";
import {
	describeLocation,
	type SharedLocation,
} from "@health/contracts/location";

import { helpMessage, tripReminder } from "./logic";

const now = Date.parse("2026-01-01T08:00:00Z");
const at = (minutesAgo: number) =>
	new Date(now - minutesAgo * 60_000).toISOString();
const fix = (minutesAgo: number, accuracyMeters = 10) => ({
	latitude: 1,
	longitude: 2,
	accuracyMeters,
	fixTime: at(minutesAgo),
});
const location = (over: Partial<SharedLocation>): SharedLocation => ({
	familyId: "1",
	sharer: "a".repeat(64),
	status: "fix",
	fix: fix(0),
	reportedAt: at(0),
	...over,
});
const kind = (over: Partial<SharedLocation>) =>
	describeLocation(location(over), now).kind;

describe("describeLocation", () => {
	test("labels a fresh, exact fix current and a wide one approximate", () => {
		expect(kind({})).toBe("current");
		expect(kind({ fix: fix(0, 100) })).toBe("current");
		expect(kind({ fix: fix(0, 101) })).toBe("approximate");
	});

	test("an old fix is last known, even when the report is new", () => {
		expect(kind({ fix: fix(10) })).toBe("current");
		expect(kind({ fix: fix(11) })).toBe("last_known");
	});

	test("GPS denied and no signal keep the last fix but never read as current", () => {
		const denied = describeLocation(location({ status: "gps_denied" }), now);
		expect(denied).toMatchObject({ kind: "gps_denied", fix: fix(0) });
		expect(kind({ status: "gps_denied", fix: null })).toBe("gps_denied");
		expect(kind({ status: "no_fix" })).toBe("no_signal");
		expect(kind({ status: "no_fix", fix: null })).toBe("no_position");
	});

	test("a silent phone wins over every other state", () => {
		expect(kind({ reportedAt: at(30) })).toBe("current");
		const silent = describeLocation(
			location({ reportedAt: at(31), status: "gps_denied" }),
			now,
		);
		expect(silent.kind).toBe("phone_silent");
		expect(silent.text).toContain("31 min");
		expect(silent.text).toContain("not carried");
	});

	test("no label claims the person is safe", () => {
		for (const over of [
			{},
			{ status: "no_fix" as const },
			{ reportedAt: at(90) },
		])
			expect(describeLocation(location(over), now).text).not.toMatch(/safe/i);
	});
});

describe("trip wording", () => {
	const trip = {
		destination: "the pharmacy",
		purpose: "pick up my pills",
		setAt: now,
	};

	test("the reminder repeats the chosen place and purpose and points to the traffic", () => {
		expect(tripReminder(trip)).toBe(
			"You are going to the pharmacy, to pick up my pills. Telly does not see the traffic. Stop, look, and listen before you cross.",
		);
		expect(tripReminder({ ...trip, purpose: "" })).toStartWith(
			"You are going to the pharmacy. ",
		);
	});

	test("the help message carries no coordinates", () => {
		const text = helpMessage(trip, true);
		expect(text).toStartWith(
			"I need help getting home. I was going to the pharmacy",
		);
		expect(text).not.toMatch(/\d+\.\d+/);
		expect(helpMessage(null, false)).toContain("I have not shared my location");
	});
});
