import { describe, expect, test } from "bun:test";
import type {
	ReminderEvent,
	ReminderHistory,
	ReminderOccurrence,
} from "@health/contracts/reminders";

import {
	BARRIERS,
	barrierWords,
	dueCheckIn,
	familyStatus,
	nextSteps,
	reportsUrgentSymptom,
	restrictionsFor,
} from "./logic";

const NOW = Date.parse("2026-10-04T12:30:00Z");

const occurrence = (o: Partial<ReminderOccurrence>): ReminderOccurrence => ({
	id: "1",
	reminderId: "9",
	familyId: "7",
	kind: "meal",
	subjectId: null,
	title: "Lunch",
	scheduledFor: "2026-10-04T12:00:00.000Z",
	state: "scheduled",
	promptDue: true,
	prompts: 1,
	nextPromptAt: "2026-10-04T12:45:00.000Z",
	...o,
});

const history = (...os: ReminderOccurrence[]): ReminderHistory => ({
	occurrences: os.map((o) => ({ occurrence: o, events: [] })),
});

describe("next steps", () => {
	test("every barrier has a step for meals and for drinks", () => {
		for (const barrier of BARRIERS)
			for (const kind of ["meal", "hydration"] as const)
				expect(nextSteps(barrier, kind).length).toBeGreaterThan(0);
	});

	test("feeling unwell or difficulty eating offers the separate help path first", () => {
		for (const barrier of ["unwell", "difficulty_eating"] as const)
			expect(nextSteps(barrier, "meal")[0]?.action).toBe("help_path");
	});

	test("barriers outside the wearer's control go to a person", () => {
		for (const barrier of ["cannot_reach", "cannot_open", "no_food"] as const)
			expect(nextSteps(barrier, "hydration").map((s) => s.action)).toEqual([
				"caregiver",
			]);
	});
});

describe("barrier words", () => {
	test("meal and drink use their own words where they differ", () => {
		expect(barrierWords("not_hungry", "meal")).toBe("I'm not hungry");
		expect(barrierWords("not_hungry", "hydration")).toBe("I'm not thirsty");
		expect(barrierWords("forgot", "hydration")).toBe("I forgot");
	});
});

describe("saved notes", () => {
	const profile = {
		preferredName: null,
		language: null,
		timeZone: null,
		accessibilityNeeds: null,
		diagnoses: null,
		allergies: ["peanuts"],
		dietaryRestrictions: [],
		fluidRestrictions: null,
		activityRestrictions: null,
		routines: null,
		contacts: null,
		familiarDestinations: null,
		devices: null,
		declinedPrompts: [],
	};

	test("a meal shows diet notes and allergies; a drink shows only fluid notes", () => {
		expect(restrictionsFor(profile, "meal")).toEqual([
			{ label: "Diet notes", items: [] },
			{ label: "Allergies", items: ["peanuts"] },
		]);
		expect(restrictionsFor(profile, "hydration")).toEqual([
			{ label: "Fluid notes", items: null },
		]);
	});
});

describe("urgent words", () => {
	test.each([
		"I'm choking",
		"I can't breathe",
		"I cannot swallow",
		"trouble breathing after lunch",
		"I have chest pain",
		"I fainted",
	])("%p takes the help path", (text) => {
		expect(reportsUrgentSymptom(text)).toBe(true);
	});

	test.each([
		"I'm not hungry",
		"I can't open the jar",
		"the soup is hard to eat",
	])("%p stays in the routine", (text) => {
		expect(reportsUrgentSymptom(text)).toBe(false);
	});
});

describe("which check-in is due", () => {
	test("a due meal or drink prompt shows; other reminder kinds do not", () => {
		expect(
			dueCheckIn(history(occurrence({ kind: "medication" })), NOW),
		).toBeNull();
		expect(
			dueCheckIn(history(occurrence({ kind: "hydration" })), NOW)?.id,
		).toBe("1");
	});

	test("a snoozed, future, or ended check-in does not show", () => {
		const cases = [
			occurrence({ state: "deferred", promptDue: false }),
			occurrence({ scheduledFor: "2026-10-04T13:00:00.000Z" }),
			occurrence({ state: "unresolved", nextPromptAt: null, promptDue: false }),
			occurrence({ state: "self_reported_complete", nextPromptAt: null }),
		];
		for (const o of cases) expect(dueCheckIn(history(o), NOW)).toBeNull();
	});

	test("a check-in shown but not answered stays until it is answered", () => {
		const shown = occurrence({ state: "delivered", promptDue: false });
		expect(dueCheckIn(history(shown), NOW)?.id).toBe("1");
	});

	test("the newest due check-in wins", () => {
		const older = occurrence({
			id: "1",
			scheduledFor: "2026-10-04T08:00:00.000Z",
		});
		const newer = occurrence({ id: "2" });
		expect(dueCheckIn(history(older, newer), NOW)?.id).toBe("2");
	});
});

describe("family status", () => {
	const event = (e: Partial<ReminderEvent>): ReminderEvent => ({
		id: "1",
		occurrenceId: "1",
		state: "scheduled",
		response: null,
		at: "2026-10-04T12:00:00.000Z",
		actor: "scheduler",
		source: "scheduler",
		wording: null,
		...e,
	});

	test("delivered, a late self-report, and unresolved stay separate facts", () => {
		const s = familyStatus([
			event({ id: "1", state: "delivered", source: "web" }),
			event({ id: "2", state: "unresolved" }),
			event({
				id: "3",
				state: "self_reported_complete",
				response: "done",
				wording: "had soup",
			}),
		]);
		expect(s.delivered?.id).toBe("1");
		expect(s.unresolved?.id).toBe("2");
		expect(s.selfReported?.id).toBe("3");
		expect(s.wording).toBe("had soup");
	});

	test("an acknowledged prompt is not a self-report", () => {
		const s = familyStatus([
			event({ state: "acknowledged", response: "okay" }),
		]);
		expect(s.selfReported).toBeNull();
		expect(s.unresolved).toBeNull();
	});
});
