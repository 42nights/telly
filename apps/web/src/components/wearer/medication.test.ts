import { describe, expect, test } from "bun:test";
import type { CareInstruction } from "@health/contracts/care-profile";
import type {
	ReminderEvent,
	ReminderOccurrence,
} from "@health/contracts/reminders";

import {
	instructionInEffect,
	medicationPrompt,
	medicationReason,
	questionSummary,
	uncertaintyAnswer,
} from "./medication";

const now = Date.parse("2026-10-04T12:00:00Z");
// Synthetic plan entries; not a real prescription.
const version = (
	id: string,
	extra: Partial<CareInstruction> = {},
): CareInstruction => ({
	id,
	familyId: "1",
	kind: "medication",
	name: "Synthetic Med A",
	instruction: "1 tablet by mouth with breakfast",
	times: ["08:00"],
	reason: "blood pressure",
	source: "demo pharmacy label",
	effectiveDate: "2026-09-01",
	timeZone: "UTC",
	editedBy: "a".repeat(64),
	editedAt: "2026-09-01T00:00:00Z",
	verification: "verified",
	verifiedBy: "b".repeat(64),
	verifiedAt: "2026-09-01T00:00:00Z",
	...extra,
});
const occurrence: ReminderOccurrence = {
	id: "7",
	reminderId: "3",
	familyId: "1",
	kind: "medication",
	subjectId: "10",
	title: "Morning tablet",
	scheduledFor: "2026-10-04T08:00:00.000Z",
	state: "unresolved",
	promptDue: false,
	prompts: 1,
	nextPromptAt: null,
};
const event = (
	id: string,
	at: string,
	state: ReminderEvent["state"],
	actor: string,
	wording: string | null = null,
): ReminderEvent => ({
	id,
	occurrenceId: "7",
	state,
	response: null,
	at,
	actor,
	source: "web",
	wording,
});
const time = (iso: string) => iso.slice(11, 16);

describe("instruction in effect", () => {
	test("a newer unverified version leaves the verified one in effect", () => {
		const plan = [
			version("11", {
				instruction: "2 tablets",
				verification: "conflicting",
				verifiedBy: null,
			}),
			version("10"),
		];
		expect(
			instructionInEffect({ ...occurrence, subjectId: "11" }, plan, now)?.id,
		).toBe("10");
	});

	test("nothing is read without a verified version in effect today", () => {
		const cases = [
			[version("10", { verification: "unverified" })],
			[version("10", { verification: "stale" })],
			[version("10", { effectiveDate: "2026-10-05" })],
			[version("10", { kind: "care" })],
			[],
		];
		for (const plan of cases)
			expect(instructionInEffect(occurrence, plan, now)).toBeNull();
	});

	test("a plan without a time zone uses this device's date", () => {
		expect(
			instructionInEffect(occurrence, [version("10", { timeZone: null })], now)
				?.id,
		).toBe("10");
	});
});

describe("question summary", () => {
	test("names the dose time and the time asked, but no medicine", () => {
		const summary = questionSummary(occurrence, "2026-10-04T08:06:00.000Z");
		expect(summary).toContain("scheduled 2026-10-04T08:00:00.000Z");
		expect(summary).toContain("asked 2026-10-04T08:06:00.000Z");
		expect(summary).not.toContain("Morning tablet");
	});
});

describe("medication prompt", () => {
	test("reads the verified instruction verbatim with its source and date", () => {
		expect(medicationPrompt("Morning tablet", version("10"))).toBe(
			"It's time for Synthetic Med A. Your saved instruction says: “1 tablet by mouth with breakfast”. Source: demo pharmacy label, from 2026-09-01.",
		);
	});

	test("without a verified instruction it reads none and refers to the caregiver", () => {
		const said = `${medicationPrompt("Morning tablet", null)} ${medicationReason(null)}`;
		expect(said).not.toContain("tablet by mouth");
		expect(said).toContain("ask your caregiver");
	});

	test("an unknown reason is said as unknown, not guessed", () => {
		expect(medicationReason(version("10", { reason: null }))).toContain(
			"does not say why",
		);
	});

	test("a saved reason is quoted from the plan", () => {
		expect(medicationReason(version("10"))).toBe(
			"Your saved plan says you take Synthetic Med A for: “blood pressure”.",
		);
	});
});

describe("did I take it?", () => {
	test("reads the recorded steps oldest first; okay is not a dose; no dose advice", () => {
		const answer = uncertaintyAnswer(
			occurrence,
			[
				event(
					"3",
					"2026-10-04T08:05:00.000Z",
					"unresolved",
					"me",
					"I'm not sure if I took it",
				),
				event("2", "2026-10-04T08:01:00.000Z", "acknowledged", "me", "okay"),
				event("1", "2026-10-04T08:00:00.000Z", "delivered", "scheduler"),
			],
			[],
			(actor) => (actor === "scheduler" ? "Telly" : "You"),
			time,
		);
		expect(answer).toEqual([
			"Here is what is recorded for Morning tablet at 08:00:",
			"08:00, Telly: the reminder was shown.",
			"08:01, You: the reminder was seen; this does not say the dose was taken, in the words “okay”.",
			"08:05, You: the reminder was left open, in the words “I'm not sure if I took it”.",
			"I can't tell you whether to take it now. Don't take another dose because of me.",
			"I can ask your family to help.",
		]);
	});

	test("self-report and caregiver confirmation stay distinct", () => {
		const answer = uncertaintyAnswer(
			occurrence,
			[
				event("1", "2026-10-04T08:02:00.000Z", "self_reported_complete", "me"),
				event("2", "2026-10-04T08:30:00.000Z", "caregiver_confirmed", "cg"),
			],
			[],
			(actor) => actor,
			time,
		).join("\n");
		expect(answer).toContain(
			"08:02, me: the dose was reported taken, by the wearer.",
		);
		expect(answer).toContain("08:30, cg: a caregiver confirmed the dose.");
	});

	test("a container sighting since the dose time reads as found, never taken", () => {
		const sighting = (id: string, seenAt: string) => ({
			id,
			familyId: "1",
			personId: "a".repeat(64),
			container: "SYNTHETIC A 10 mg tablets",
			place: "Kitchen counter",
			seenAt,
			source: "camera_check" as const,
			confidence: 0.9,
			labelRead: true,
			savedBy: "me",
			notFoundAt: null,
		});
		const answer = uncertaintyAnswer(
			occurrence,
			[event("2", "2026-10-04T08:05:00.000Z", "unresolved", "me")],
			[
				sighting("9", "2026-10-04T08:03:00.000Z"),
				// Before this dose time: not evidence for it.
				sighting("8", "2026-10-03T20:00:00.000Z"),
			],
			(actor) => actor,
			time,
		);
		expect(answer.slice(1, 3)).toEqual([
			"08:03, me: container found, “SYNTHETIC A 10 mg tablets” at Kitchen counter; this does not say the dose was taken.",
			"08:05, me: the reminder was left open.",
		]);
		expect(answer.join("\n")).not.toContain("20:00");
	});
});
