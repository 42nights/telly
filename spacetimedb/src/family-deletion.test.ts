import { describe, expect, test } from "bun:test";
import {
	at,
	type Harness as H,
	harness,
	identity,
	mod,
} from "./test/harness.test";

const alice = identity(1);
const bob = identity(2);
const carol = identity(3);
const dave = identity(4);
const erin = identity(5);
const op = identity(9);

// One family with a row in every kind of table a family owns, including the tables keyed by
// another table's id (threshold triggers, ladder and reminder timers, reminder requests).
const fill = (
	h: H,
	founder: typeof alice,
	members: (typeof alice)[],
	name: string,
) => {
	h.call(mod.createFamily, founder, { name });
	const familyId = BigInt(h.rows("family").length);
	for (const member of members)
		h.call(mod.addFamilyMember, founder, { familyId, member });
	h.call(mod.setAlertThreshold, founder, {
		familyId,
		metric: "heart_rate",
		direction: { tag: "Above" },
		limit: 120,
		unit: "bpm",
		maxAgeSeconds: 300,
	});
	h.call(mod.recordSample, founder, {
		familyId,
		metric: "heart_rate",
		value: 130,
		unit: "bpm",
		sourceTime: at("2026-01-05T11:59:00Z"),
		source: "watch",
		synthetic: false,
		quality: { tag: "Validated" },
	});
	const alertId = h
		.rows<{ id: bigint; familyId: bigint }>("alert")
		.find((a) => a.familyId === familyId)?.id;
	if (alertId === undefined) throw new Error("no threshold alert");
	h.call(mod.acknowledgeAlert, founder, { alertId });
	h.call(mod.sendMessage, founder, { familyId, clientId: "m1", body: "Hi" });
	h.call(mod.setContactLadder, founder, {
		familyId,
		contacts: members.map((member, i) => ({
			member,
			name: `Contact ${i}`,
			timeZone: "UTC",
			detail: { tag: "Summary" },
			callFor: [],
		})),
		backup: undefined,
		answerSeconds: 60,
		followUpSeconds: 600,
	});
	h.call(mod.openCareNeed, founder, {
		familyId,
		clientId: "n1",
		kind: { tag: "Help" },
		summary: "A lift",
		sampleIds: [],
		dueAt: undefined,
	});
	h.call(mod.setReminderSettings, founder, {
		familyId,
		timeZone: "UTC",
		quietStart: undefined,
		quietEnd: undefined,
		repeatEveryMinutes: 10,
		maxPrompts: 2,
		snoozeMinutes: 30,
	});
	h.call(mod.createReminder, founder, {
		familyId,
		// Reminder client ids are unique across families.
		clientId: `r${familyId}`,
		kind: "medication",
		subjectId: undefined,
		title: "Pills",
		times: [13 * 60],
	});
	const occurrenceId = h
		.rows<{ id: bigint; familyId: bigint }>("reminderOccurrence")
		.find((o) => o.familyId === familyId)?.id;
	if (occurrenceId === undefined) throw new Error("no occurrence");
	h.call(mod.answerReminder, founder, {
		occurrenceId,
		clientId: "a1",
		source: "phone",
		response: "okay",
		wording: undefined,
	});
	h.call(mod.recordMealFact, founder, {
		familyId,
		mealId: "meal-1",
		fact: JSON.stringify({ type: "intake_report" }),
	});
	h.call(mod.createReport, founder, {
		id: `report-${familyId}`,
		familyId,
		markers: "{}",
		fields: "{}",
	});
	h.call(mod.linkFinchnodeSubject, founder, {
		familyId,
		subject: "u_1",
		synthetic: true,
	});
	h.call(mod.setMedicineMemory, founder, {
		familyId,
		enabled: true,
		places: ["Kitchen"],
	});
	h.call(mod.saveCookingProfile, founder, { familyId, profile: "{}" });
	return familyId;
};

// Every table except the deletion log, as stored now.
const tables = (h: H) =>
	Object.fromEntries(
		Object.keys(h.db)
			.filter((name) => name !== "familyDeletion")
			.map((name) => [name, h.rows(name)]),
	);

describe("deleteFamily", () => {
	const setup = () => {
		const h = harness("2026-01-05T12:00:00Z");
		h.call(mod.init, op, {});
		fill(h, dave, [erin], "Other");
		const other = tables(h);
		const familyId = fill(h, alice, [bob, carol], "Rivera");
		return { h, other, familyId };
	};

	test("removes every row of the family and leaves the other family as it was", () => {
		const { h, other, familyId } = setup();
		// The fixture reaches every key-only table, so the comparison below covers them.
		for (const name of [
			"thresholdTrigger",
			"ladderTimer",
			"reminderTimer",
			"reminderRequest",
			"contactAttempt",
			"acknowledgement",
			"alertDelivery",
		])
			expect(h.rows(name).length).toBeGreaterThan(other[name]?.length ?? 0);

		h.call(mod.deleteFamily, alice, { familyId, name: "Rivera" });

		expect(tables(h)).toEqual(other);
		expect(h.rows("familyDeletion")).toEqual([
			{ id: 1n, familyId, deletedBy: alice, deletedAt: h.now },
		]);
		expect(h.view(mod.myFamilies, alice)).toEqual([]);
		expect(h.view(mod.myFamilies, dave)).toHaveLength(1);
	});

	test("a member without family_access, an outsider, or a wrong name deletes nothing", () => {
		const { h, familyId } = setup();
		const before = tables(h);
		expect(() =>
			h.call(mod.deleteFamily, bob, { familyId, name: "Rivera" }),
		).toThrow("no care access: family_access");
		expect(() =>
			h.call(mod.deleteFamily, dave, { familyId, name: "Rivera" }),
		).toThrow("not a member of this family");
		expect(() =>
			h.call(mod.deleteFamily, alice, { familyId, name: "rivera" }),
		).toThrow("the name does not match this family");
		expect(tables(h)).toEqual(before);
		expect(h.rows("familyDeletion")).toEqual([]);
	});

	test("a member granted family_access may delete it", () => {
		const { h, familyId } = setup();
		h.call(mod.setCareGrant, alice, {
			familyId,
			member: bob,
			scope: "family_access",
			granted: true,
		});
		h.call(mod.deleteFamily, bob, { familyId, name: "Rivera" });
		expect(h.rows("familyDeletion")).toMatchObject([
			{ familyId, deletedBy: bob },
		]);
	});
});
