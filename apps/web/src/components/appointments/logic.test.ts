import { describe, expect, test } from "bun:test";

import { draftOf, formatVisitTime, localToUtc, prepOf } from "./logic";

describe("visit times", () => {
	test("a wall-clock time converts to UTC in the visit's zone on both sides of DST", () => {
		// London: BST (UTC+1) until 25 Oct 2026, GMT after.
		expect(localToUtc("2026-10-20T10:30", "Europe/London")).toBe(
			"2026-10-20T09:30:00.000Z",
		);
		expect(localToUtc("2026-10-27T10:30", "Europe/London")).toBe(
			"2026-10-27T10:30:00.000Z",
		);
		expect(localToUtc("2026-10-20T10:30", "America/Los_Angeles")).toBe(
			"2026-10-20T17:30:00.000Z",
		);
		expect(localToUtc("2026-03-08T12:00", "America/New_York")).toBe(
			"2026-03-08T16:00:00.000Z",
		);
		expect(() => localToUtc("", "Europe/London")).toThrow();
	});

	test("an instant shows in the visit's zone, not the viewer's", () => {
		const london = formatVisitTime("2026-10-20T09:30:00.000Z", "Europe/London");
		expect(london).toContain("20 Oct 2026");
		expect(london).toContain("10:30 BST");
		const tokyo = formatVisitTime("2026-10-20T09:30:00.000Z", "Asia/Tokyo");
		expect(tokyo).toContain("18:30 GMT+9");
	});
});

test("the prep form keeps one entry per line and unknown transport as null", () => {
	const prep = prepOf({
		transportation: "  ",
		reminders: [120, 1440],
		symptoms: " Tired \n\n Dizzy",
		medication: "",
		eatingSleep: "Wakes at 3 am",
		questions: "Dose time?",
	});
	expect(prep).toEqual({
		transportation: null,
		reminders: [1440, 120],
		symptoms: ["Tired", "Dizzy"],
		medication: [],
		eatingSleep: ["Wakes at 3 am"],
		questions: ["Dose time?"],
	});
	expect(prepOf(draftOf(prep))).toEqual(prep);
});
