import { describe, expect, test } from "bun:test";
import { at, harness, identity, MODULE, mod } from "./test/harness.test";

// Alice founded family 1, so she is its wearer; Bob is another member; `op` is the delivery operator.
const alice = identity(1);
const bob = identity(2);
const op = identity(9);
const HASH = "a".repeat(64);

type H = ReturnType<typeof harness>;

const setup = (quiet?: { quietStart: number; quietEnd: number }) => {
	const h = harness("2026-01-05T12:00:00Z");
	h.call(mod.init, op, {});
	h.call(mod.createFamily, alice, { name: "Rivera" });
	h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
	h.call(mod.setReminderSettings, alice, {
		familyId: 1n,
		timeZone: "UTC",
		quietStart: quiet?.quietStart,
		quietEnd: quiet?.quietEnd,
		repeatEveryMinutes: 10,
		maxPrompts: 2,
		snoozeMinutes: 30,
	});
	return h;
};

const pending = (h: H, who = op) => h.view(mod.pendingWearerTexts, who);

/** Runs the reminder's newest timer as the scheduler. */
const fire = (h: H) => {
	const timer = h.rows<{ dueAt: never }>("reminderTimer").at(-1);
	if (timer === undefined) throw new Error("no reminder timer");
	h.now = timer.dueAt;
	h.call(mod.runReminderTimer, MODULE, { timer });
};

describe("wearer texts", () => {
	test("a reminder texts once; only the operator reads or settles the queue", () => {
		const h = setup();
		h.call(mod.createReminder, alice, {
			familyId: 1n,
			clientId: "r1",
			kind: "medication",
			subjectId: undefined,
			title: "Blood pressure pill",
			times: [13 * 60],
		});
		expect(pending(h)).toEqual([]);
		fire(h);
		fire(h);
		expect(pending(h)).toMatchObject([
			{
				key: "reminder-1",
				familyId: 1n,
				body: "Time for your medicine: Blood pressure pill. Reply DONE when you have taken it.",
			},
		]);
		expect(pending(h, alice)).toEqual([]);
		const settle = { key: "reminder-1", sent: true, note: undefined };
		expect(() => h.call(mod.settleWearerText, alice, settle)).toThrow(
			"not the delivery operator",
		);
		h.call(mod.settleWearerText, op, settle);
		h.call(mod.settleWearerText, op, settle);
		expect(pending(h)).toEqual([]);
		expect(
			h.rows("reminderEvent").filter((e) => e.source === "imessage"),
		).toHaveLength(1);
	});

	test("an unanswered medicine reminder texts a missed dose; DONE answers it", () => {
		const h = setup();
		h.call(mod.createReminder, alice, {
			familyId: 1n,
			clientId: "r1",
			kind: "medication",
			subjectId: undefined,
			title: "Pill",
			times: [13 * 60],
		});
		fire(h);
		h.call(mod.settleWearerText, op, {
			key: "reminder-1",
			sent: true,
			note: undefined,
		});
		fire(h);
		fire(h);
		expect(pending(h).map((t) => t.key)).toEqual(["missed-1"]);
		h.call(mod.answerTextedReminder, op, { familyId: 1n, wording: "Done" });
		const occurrence = h
			.rows<{ id: bigint; state: string }>("reminderOccurrence")
			.find((o) => o.id === 1n);
		expect(occurrence?.state).toBe("self_reported_complete");
		expect(() =>
			h.call(mod.answerTextedReminder, op, { familyId: 1n, wording: "Done" }),
		).toThrow("no texted reminder is open");
	});

	test("a family meal time texts the wearer; their reply is recorded in their words", () => {
		// Quiet from 22:00 to 07:00 UTC: a 23:00 drink waits until 07:00.
		const h = setup({ quietStart: 22 * 60, quietEnd: 7 * 60 });
		h.call(mod.createReminder, bob, {
			familyId: 1n,
			clientId: "lunch",
			kind: "meal",
			subjectId: undefined,
			title: "Lunch",
			times: [12 * 60 + 30],
		});
		h.call(mod.createReminder, bob, {
			familyId: 1n,
			clientId: "water",
			kind: "hydration",
			subjectId: undefined,
			title: "Drink water",
			times: [23 * 60],
		});
		const lunch = h.rows<{ dueAt: never }>("reminderTimer")[0];
		if (lunch === undefined) throw new Error("no lunch timer");
		h.now = lunch.dueAt;
		h.call(mod.runReminderTimer, MODULE, { timer: lunch });
		expect(pending(h)).toMatchObject([
			{
				key: "reminder-1",
				body: "Time to eat: Lunch. Reply DONE when you have eaten.",
			},
		]);
		h.call(mod.settleWearerText, op, {
			key: "reminder-1",
			sent: true,
			note: undefined,
		});
		h.call(mod.answerTextedReminder, op, {
			familyId: 1n,
			wording: "I ate lunch",
		});
		expect(
			h.view(mod.myReminderEvents, bob).filter((e) => e.source === "imessage"),
		).toMatchObject([
			{ state: "delivered" },
			{ state: "self_reported_complete", wording: "I ate lunch" },
		]);
		const water = h
			.rows<{ occurrenceId: bigint; dueAt: { toDate(): Date } }>(
				"reminderTimer",
			)
			.find((t) => t.occurrenceId === 2n);
		expect(water?.dueAt.toDate().toISOString()).toBe(
			"2026-01-06T07:00:00.000Z",
		);
	});

	test("an alert inside quiet hours waits for their end; a synthetic sample texts nothing", () => {
		// Quiet from 11:00 to 13:00 UTC; the clock starts at 12:00.
		const h = setup({ quietStart: 11 * 60, quietEnd: 13 * 60 });
		h.call(mod.raiseAlert, bob, {
			familyId: 1n,
			sampleId: undefined,
			summary: "Asked for help",
		});
		h.call(mod.recordSample, alice, {
			familyId: 1n,
			metric: "heart_rate",
			value: 150,
			unit: "bpm",
			sourceTime: h.now,
			source: "demo",
			synthetic: true,
			quality: { tag: "Unvalidated" },
		});
		h.call(mod.raiseAlert, bob, {
			familyId: 1n,
			sampleId: 1n,
			summary: "Synthetic: heart rate high",
		});
		expect(pending(h)).toMatchObject([
			{
				key: "alert-1",
				body: "Telly told your family: Asked for help",
				notBefore: at("2026-01-05T13:00:00Z"),
			},
		]);
	});
});

describe("finder links", () => {
	const linkSetup = () => {
		const h = setup();
		for (const personId of [alice, bob])
			h.call(mod.setMedicineMemory, personId, {
				familyId: 1n,
				personId,
				enabled: true,
				places: ["kitchen"],
			});
		for (const [personId, container] of [
			[alice, "Aspirin"],
			[bob, "Ibuprofen"],
		] as const)
			h.call(mod.rememberMedicine, personId, {
				familyId: 1n,
				personId,
				container,
				place: "kitchen",
				seenAt: h.now,
				source: "camera",
				confidence: 0.9,
				labelRead: true,
			});
		h.call(mod.createFinderLink, op, { familyId: 1n, tokenHash: HASH });
		return h;
	};
	const open = (h: H, sessionHash = "s1") =>
		h.call(mod.openFinderLink, op, { tokenHash: HASH, sessionHash });

	test("a link shows only the wearer's places, to the operator only", () => {
		const h = linkSetup();
		expect(() =>
			h.call(mod.createFinderLink, bob, {
				familyId: 1n,
				tokenHash: "b".repeat(64),
			}),
		).toThrow("not the delivery operator");
		expect(h.view(mod.finderLinks, bob)).toEqual([]);
		const [link] = h.view(mod.finderLinks, op);
		expect(link).toMatchObject({ personId: alice, remembering: true });
		expect(link?.sightings).toMatchObject([{ container: "Aspirin" }]);
	});

	test("a link opens once, and never after 15 minutes", () => {
		const h = linkSetup();
		open(h);
		expect(() => open(h, "s2")).toThrow("the finder link was used");
		h.call(mod.createFinderLink, op, {
			familyId: 1n,
			tokenHash: "c".repeat(64),
		});
		h.advance(15 * 60);
		expect(() =>
			h.call(mod.openFinderLink, op, {
				tokenHash: "c".repeat(64),
				sessionHash: "s3",
			}),
		).toThrow("the finder link has expired");
		expect(() =>
			h.call(mod.rememberByFinderLink, op, {
				tokenHash: "c".repeat(64),
				container: "Keys",
				place: "hall table",
				seenAt: h.now,
				confidence: 0.8,
				labelRead: false,
			}),
		).toThrow("the finder link has expired");
	});

	test("a live link saves a sighting for its person", () => {
		const h = linkSetup();
		h.call(mod.rememberByFinderLink, op, {
			tokenHash: HASH,
			container: "Keys",
			place: "hall table",
			seenAt: h.now,
			confidence: 0.8,
			labelRead: false,
		});
		expect(
			h
				.rows<{ container: string; personId: unknown }>("medicineSighting")
				.find((s) => s.container === "Keys")?.personId,
		).toEqual(alice);
	});
});
