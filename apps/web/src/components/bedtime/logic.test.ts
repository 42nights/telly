import { describe, expect, test } from "bun:test";

import type { ReminderOccurrence } from "@health/contracts/reminders";

import {
	awaitsAnswer,
	chargeLine,
	connectionLine,
	fallbackText,
	speakerLine,
	timerLeft,
	tonight,
} from "./logic";

const NOW = Date.parse("2026-10-04T22:00:00.000Z");
const occurrence = (
	id: string,
	change: Partial<ReminderOccurrence>,
): ReminderOccurrence => ({
	id,
	reminderId: "1",
	familyId: "7",
	kind: "medication",
	subjectId: null,
	title: `Synthetic reminder ${id}`,
	scheduledFor: "2026-10-05T02:00:00.000Z",
	state: "scheduled",
	promptDue: false,
	prompts: 0,
	nextPromptAt: "2026-10-05T02:00:00.000Z",
	...change,
});

describe("overnight reminders", () => {
	test("only scheduled prompts in the next 12 hours count, soonest first", () => {
		const ids = tonight(
			[
				occurrence("late", { nextPromptAt: "2026-10-05T09:59:00.000Z" }),
				occurrence("soon", {}),
				occurrence("tomorrow", { nextPromptAt: "2026-10-05T10:01:00.000Z" }),
				occurrence("ended", { state: "unresolved", nextPromptAt: null }),
				occurrence("showing", { state: "delivered" }),
				occurrence("due", { promptDue: true }),
			],
			NOW,
		).map((u) => u.id);
		expect(ids).toEqual(["soon", "late"]);
	});

	test("a reminder held by quiet hours says so", () => {
		const [held] = tonight(
			[occurrence("held", { nextPromptAt: "2026-10-05T07:00:00.000Z" })],
			NOW,
		);
		expect(held?.text).toContain("held by quiet hours");
		const [snoozed] = tonight(
			[
				occurrence("snoozed", {
					state: "deferred",
					nextPromptAt: "2026-10-05T02:10:00.000Z",
				}),
			],
			NOW,
		);
		expect(snoozed?.text).not.toContain("quiet hours");
	});

	test("a shown prompt waits for an answer until one is recorded", () => {
		expect(awaitsAnswer(occurrence("a", { promptDue: true }))).toBe(true);
		expect(awaitsAnswer(occurrence("b", { state: "delivered" }))).toBe(true);
		expect(awaitsAnswer(occurrence("c", { state: "acknowledged" }))).toBe(
			false,
		);
	});

	test("an unanswered prompt repeats by the saved routine and never calls 911", () => {
		expect(
			fallbackText({
				timeZone: "America/New_York",
				quietHours: null,
				repeatEveryMinutes: 5,
				maxPrompts: 3,
				snoozeMinutes: 10,
			}),
		).toBe(
			"If nobody answers, I ask again every 5 minutes, up to 3 times. Then your family sees it as unanswered. Nobody calls 911.",
		);
	});
});

describe("overnight readiness", () => {
	test("an unknown battery is not ready and is not shown as a zero charge", () => {
		expect(chargeLine(null)).toMatchObject({ ok: false });
		expect(chargeLine(null).text).toContain("unknown");
		expect(chargeLine({ level: 0, charging: true })).toEqual({
			ok: true,
			text: "Charging · 0 %",
		});
		expect(chargeLine({ level: 0.9, charging: false }).ok).toBe(false);
	});

	test("the network being up does not mean the server answers", () => {
		expect(connectionLine(false, true).ok).toBe(false);
		expect(connectionLine(true, false)).toEqual({
			ok: false,
			text: "Network on, but the server does not answer.",
		});
		expect(connectionLine(true, true).ok).toBe(true);
	});

	test("the home speaker is ready only when it is on and online", () => {
		expect(speakerLine(null, "online").ok).toBe(false);
		expect(speakerLine(false, "online").ok).toBe(false);
		expect(speakerLine(true, null).ok).toBe(false);
		expect(speakerLine(true, "offline").text).toBe(
			"Home speaker offline · prompts show on this phone.",
		);
		expect(speakerLine(true, "online").ok).toBe(true);
	});

	test("the sleep timer counts down to zero and never below", () => {
		expect(timerLeft(null, 0)).toBeNull();
		expect(timerLeft(30 * 60_000, 0)).toBe("30:00");
		expect(timerLeft(65_500, 0)).toBe("1:06");
		expect(timerLeft(1_000, 5_000)).toBe("0:00");
	});
});
