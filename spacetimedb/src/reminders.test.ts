import { describe, expect, test } from "bun:test";
import { at, harness, identity, MODULE, mod } from "./test/harness.test";

const alice = identity(1);
const bob = identity(2);
const mallory = identity(3);

const rules = {
	familyId: 1n,
	timeZone: "UTC",
	quietStart: undefined as number | undefined,
	quietEnd: undefined as number | undefined,
	repeatEveryMinutes: 10,
	maxPrompts: 2,
	snoozeMinutes: 30,
};

const reminderInput = {
	familyId: 1n,
	clientId: "r1",
	kind: "medication",
	subjectId: undefined as string | undefined,
	title: "Pills",
	times: [13 * 60],
};

type H = ReturnType<typeof harness>;

const setup = (settings: Partial<typeof rules> = {}, kind = "medication") => {
	const h = harness("2026-01-05T12:00:00Z");
	h.call(mod.createFamily, alice, { name: "Rivera" });
	h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
	h.call(mod.setReminderSettings, alice, { ...rules, ...settings });
	h.call(mod.createReminder, alice, { ...reminderInput, kind });
	return h;
};

const occ = (h: H, id = 1n) => {
	const row = h.rows("reminderOccurrence").find((o) => o.id === id);
	if (row === undefined) throw new Error(`no occurrence ${id}`);
	return row;
};
const timers = (h: H, id = 1n) =>
	h.rows("reminderTimer").filter((t) => t.occurrenceId === id);
const lastTimer = (h: H, id = 1n) => {
	const timer = timers(h, id).at(-1);
	if (timer === undefined) throw new Error(`no timer for occurrence ${id}`);
	return timer;
};
/** Moves the clock to the occurrence's newest timer and runs it as the scheduler. */
const fire = (h: H, id = 1n) => {
	const timer = lastTimer(h, id);
	h.now = timer.dueAt;
	h.call(mod.runReminderTimer, MODULE, { timer });
};
const answer = (
	h: H,
	response: string,
	clientId = response,
	wording?: string,
) =>
	h.call(mod.answerReminder, alice, {
		occurrenceId: 1n,
		clientId,
		source: "phone",
		response,
		wording,
	});

describe("setReminderSettings", () => {
	test("stores, then updates one row per family; views show members only", () => {
		const h = setup();
		h.call(mod.setReminderSettings, bob, { ...rules, maxPrompts: 5 });
		expect(h.rows("reminderSettings")).toMatchObject([
			{ familyId: 1n, maxPrompts: 5, updatedBy: bob },
		]);
		expect(h.view(mod.myReminderSettings, alice)).toHaveLength(1);
		expect(h.view(mod.myReminderSettings, mallory)).toEqual([]);
	});

	test.each([
		[{ timeZone: "Mars/Olympus" }, "timeZone is not a known IANA time zone"],
		[{ quietStart: 60 }, "quiet hours need both a start and an end"],
		[{ quietEnd: 60 }, "quiet hours need both a start and an end"],
		[{ quietStart: 1440, quietEnd: 60 }, "quiet hours must be times of day"],
		[{ quietStart: 60, quietEnd: 1440 }, "quiet hours must be times of day"],
		[
			{ repeatEveryMinutes: 0 },
			"repeat spacing and snooze must be 1 to 240 minutes",
		],
		[
			{ snoozeMinutes: 241 },
			"repeat spacing and snooze must be 1 to 240 minutes",
		],
		[{ maxPrompts: 0 }, "maxPrompts must be 1 to 10"],
		[{ maxPrompts: 11 }, "maxPrompts must be 1 to 10"],
	])("rejects %p", (bad, message) => {
		const h = harness();
		h.call(mod.createFamily, alice, { name: "Rivera" });
		expect(() =>
			h.call(mod.setReminderSettings, alice, { ...rules, ...bad }),
		).toThrow(message);
		expect(h.rows("reminderSettings")).toEqual([]);
	});

	test("accepts the boundaries and rejects outsiders", () => {
		const h = harness();
		h.call(mod.createFamily, alice, { name: "Rivera" });
		h.call(mod.setReminderSettings, alice, {
			...rules,
			quietStart: 1439,
			quietEnd: 0,
			repeatEveryMinutes: 240,
			snoozeMinutes: 1,
			maxPrompts: 10,
		});
		expect(h.rows("reminderSettings")).toMatchObject([
			{ quietStart: 1439, quietEnd: 0 },
		]);
		expect(() => h.call(mod.setReminderSettings, mallory, rules)).toThrow(
			"not a member of this family",
		);
	});
});

describe("createReminder", () => {
	test("needs settings first", () => {
		const h = harness();
		h.call(mod.createFamily, alice, { name: "Rivera" });
		expect(() => h.call(mod.createReminder, alice, reminderInput)).toThrow(
			"save the reminder settings first",
		);
	});

	test.each([
		[{ clientId: " " }, "clientId must not be empty"],
		[{ title: "" }, "title must not be empty"],
		[{ kind: "nap" }, "kind is not a reminder kind"],
		[{ times: [] }, "times must be 1 to 12 times of day"],
		[
			{ times: Array.from({ length: 13 }, (_, i) => i) },
			"times must be 1 to 12 times of day",
		],
		[{ times: [1440] }, "times must be 1 to 12 times of day"],
	])("rejects %p", (bad, message) => {
		const h = harness();
		h.call(mod.createFamily, alice, { name: "Rivera" });
		h.call(mod.setReminderSettings, alice, rules);
		expect(() =>
			h.call(mod.createReminder, alice, { ...reminderInput, ...bad }),
		).toThrow(message);
		expect(h.rows("reminder")).toEqual([]);
	});

	test("schedules one occurrence per distinct time; a resend is a no-op", () => {
		const h = harness("2026-01-05T12:00:00Z");
		h.call(mod.createFamily, alice, { name: "Rivera" });
		h.call(mod.setReminderSettings, alice, rules);
		const input = { ...reminderInput, times: [13 * 60, 13 * 60, 8 * 60] };
		h.call(mod.createReminder, alice, input);
		h.call(mod.createReminder, alice, { ...input, title: "Other" });
		expect(h.rows("reminder")).toMatchObject([
			{ id: 1n, title: "Pills", createdBy: alice },
		]);
		expect(h.rows("reminderOccurrence")).toMatchObject([
			{
				scheduledFor: at("2026-01-05T13:00:00Z"),
				state: "scheduled",
				prompts: 0,
				promptDue: false,
			},
			{ scheduledFor: at("2026-01-06T08:00:00Z") },
		]);
		expect(h.rows("reminderTimer")).toMatchObject([
			{ occurrenceId: 1n, dueAt: at("2026-01-05T13:00:00Z") },
			{ occurrenceId: 2n, dueAt: at("2026-01-06T08:00:00Z") },
		]);
		expect(h.rows("reminderEvent")).toMatchObject([
			{
				occurrenceId: 1n,
				state: "scheduled",
				source: "scheduler",
				actor: undefined,
			},
			{ occurrenceId: 2n, state: "scheduled" },
		]);
		expect(h.view(mod.myReminders, bob)).toEqual([]);
		expect(h.view(mod.myReminders, alice)).toHaveLength(1);
		expect(h.view(mod.myReminderOccurrences, alice)).toHaveLength(2);
		expect(h.view(mod.myReminderEvents, alice)).toHaveLength(2);
		expect(h.view(mod.myReminderEvents, mallory)).toEqual([]);
	});

	test("holds the first prompt until quiet hours end", () => {
		const h = setup({ quietStart: 12 * 60 + 30, quietEnd: 14 * 60 });
		expect(occ(h)).toMatchObject({
			scheduledFor: at("2026-01-05T13:00:00Z"),
			nextPromptAt: at("2026-01-05T14:00:00Z"),
		});
		expect(lastTimer(h).dueAt).toEqual(at("2026-01-05T14:00:00Z"));
	});
});

describe("deleteReminder", () => {
	test("drops future untouched occurrences with their events; keeps history", () => {
		const h = setup();
		fire(h); // occurrence 1 prompted; occurrence 2 (tomorrow) scheduled
		expect(h.rows("reminderOccurrence")).toHaveLength(2);
		h.call(mod.deleteReminder, bob, { reminderId: 1n });
		expect(h.rows("reminder")).toEqual([]);
		expect(h.rows("reminderOccurrence").map((o) => o.id)).toEqual([1n]);
		expect(h.rows("reminderEvent").every((e) => e.occurrenceId === 1n)).toBe(
			true,
		);
	});

	test("keeps an untouched occurrence already past its time", () => {
		const h = setup();
		h.advance(2 * 3600);
		h.call(mod.deleteReminder, alice, { reminderId: 1n });
		expect(h.rows("reminderOccurrence")).toHaveLength(1);
	});

	test("keeps a future occurrence that was answered", () => {
		const h = setup();
		answer(h, "done");
		h.call(mod.deleteReminder, alice, { reminderId: 1n });
		expect(h.rows("reminderOccurrence")).toHaveLength(1);
	});

	test("hides missing ids and other families alike", () => {
		const h = setup();
		expect(() => h.call(mod.deleteReminder, alice, { reminderId: 9n })).toThrow(
			"not a member of this family",
		);
		expect(() =>
			h.call(mod.deleteReminder, mallory, { reminderId: 1n }),
		).toThrow("not a member of this family");
		expect(h.rows("reminder")).toHaveLength(1);
	});
});

describe("runReminderTimer", () => {
	test("only the database runs it", () => {
		const h = setup();
		expect(() =>
			h.call(mod.runReminderTimer, alice, { timer: lastTimer(h) }),
		).toThrow("only the database runs reminder timers");
	});

	test("prompts, repeats, then ends unresolved without opening a need", () => {
		const h = setup();
		fire(h);
		expect(occ(h)).toMatchObject({
			promptDue: true,
			prompts: 1,
			nextPromptAt: at("2026-01-05T13:10:00Z"),
		});
		// The first run schedules tomorrow's occurrence, once.
		expect(occ(h, 2n).scheduledFor).toEqual(at("2026-01-06T13:00:00Z"));
		fire(h);
		expect(occ(h)).toMatchObject({
			prompts: 2,
			nextPromptAt: at("2026-01-05T13:20:00Z"),
		});
		expect(h.rows("reminderOccurrence")).toHaveLength(2);
		fire(h);
		expect(occ(h)).toMatchObject({
			state: "unresolved",
			promptDue: false,
			nextPromptAt: undefined,
		});
		expect(h.rows("reminderEvent").at(-1)).toMatchObject({
			state: "unresolved",
			source: "scheduler",
			actor: undefined,
		});
		expect(h.rows("careNeed")).toEqual([]);
	});

	test("a stale or orphan timer does nothing", () => {
		const h = setup();
		const first = lastTimer(h);
		fire(h);
		const before = occ(h);
		h.call(mod.runReminderTimer, MODULE, { timer: first });
		h.call(mod.runReminderTimer, MODULE, {
			timer: { ...first, occurrenceId: 99n },
		});
		expect(occ(h)).toEqual(before);
	});

	test("a deleted reminder gets no next occurrence", () => {
		const h = setup();
		h.advance(2 * 3600);
		h.call(mod.deleteReminder, alice, { reminderId: 1n });
		const timer = lastTimer(h);
		h.call(mod.runReminderTimer, MODULE, { timer });
		expect(h.rows("reminderOccurrence")).toHaveLength(1);
		expect(occ(h).prompts).toBe(1);
	});

	test("repeat prompts wait out quiet hours", () => {
		const h = setup({ quietStart: 13 * 60 + 5, quietEnd: 15 * 60 });
		fire(h);
		expect(occ(h).nextPromptAt).toEqual(at("2026-01-05T15:00:00Z"));
	});

	test.each(["meal", "hydration"])(
		"an unresolved %s check-in asks the ladder once",
		(kind) => {
			const h = setup({ maxPrompts: 1 }, kind);
			fire(h);
			fire(h);
			expect(h.rows("careNeed")).toEqual([]); // no ladder, no need
			const h2 = setup({ maxPrompts: 1 }, kind);
			h2.call(mod.setContactLadder, alice, {
				familyId: 1n,
				contacts: [
					{
						member: bob,
						name: "Bob",
						timeZone: "UTC",
						detail: { tag: "Summary" },
						callFor: [],
					},
				],
				backup: undefined,
				answerSeconds: 60,
				followUpSeconds: 60,
			});
			fire(h2);
			fire(h2);
			expect(h2.rows("careNeed")).toMatchObject([
				{ kind: { tag: "Help" }, summary: "Pills: no answer after 1 prompts" },
			]);
		},
	);
});

describe("recordReminderDelivery", () => {
	test("records a due prompt once; retries and undue prompts record nothing", () => {
		const h = setup();
		const deliver = (clientId: string, source = "speaker") =>
			h.call(mod.recordReminderDelivery, bob, {
				occurrenceId: 1n,
				clientId,
				source,
			});
		deliver("d0");
		expect(occ(h).state).toBe("scheduled");
		fire(h);
		deliver("d1");
		deliver("d1");
		expect(occ(h)).toMatchObject({ state: "delivered", promptDue: false });
		expect(
			h.rows("reminderEvent").filter((e) => e.state === "delivered"),
		).toMatchObject([{ source: "speaker", actor: bob }]);
		expect(() => deliver("d1", "phone")).toThrow(
			"clientId is already used for another request",
		);
		expect(() => deliver("d2", "radio")).toThrow(
			"source must be phone, web, glasses, or speaker",
		);
		expect(() => deliver(" ")).toThrow("clientId must not be empty");
	});

	test("hides missing and foreign occurrences", () => {
		const h = setup();
		for (const [who, id] of [
			[alice, 9n],
			[mallory, 1n],
		] as const)
			expect(() =>
				h.call(mod.recordReminderDelivery, who, {
					occurrenceId: id,
					clientId: "x",
					source: "web",
				}),
			).toThrow("not a member of this family");
	});
});

describe("answerReminder", () => {
	test.each([
		["okay", "acknowledged", true],
		["dismissed", "acknowledged", true],
		["stop", "declined", false],
		["done", "self_reported_complete", false],
		["already_did_it", "self_reported_complete", false],
		["help", "unresolved", false],
		["unsure", "unresolved", false],
	])("%s -> %s", (response, state, prompting) => {
		const h = setup();
		fire(h);
		answer(h, response, "c", "spoken words");
		const o = occ(h);
		expect(o).toMatchObject({ state, promptDue: false });
		expect(o.nextPromptAt !== undefined).toBe(prompting);
		expect(h.rows("reminderEvent").at(-1)).toMatchObject({
			state,
			response,
			source: "phone",
			wording: "spoken words",
			actor: alice,
		});
	});

	test.each([
		["later", "2026-01-05T13:30:00Z"],
		["not_now", "2026-01-05T13:10:00Z"],
	])("%s defers and resets the prompt count", (response, next) => {
		const h = setup();
		fire(h);
		answer(h, response);
		expect(occ(h)).toMatchObject({
			state: "deferred",
			prompts: 0,
			promptDue: false,
			nextPromptAt: at(next),
		});
		expect(lastTimer(h).dueAt).toEqual(at(next));
	});

	test("repeat asks for the prompt again without changing state", () => {
		const h = setup();
		fire(h);
		h.call(mod.recordReminderDelivery, alice, {
			occurrenceId: 1n,
			clientId: "d",
			source: "web",
		});
		answer(h, "repeat");
		expect(occ(h)).toMatchObject({ state: "delivered", promptDue: true });
	});

	test("done is recorded once; a retry with the same clientId is a no-op", () => {
		const h = setup();
		answer(h, "done", "a");
		answer(h, "done", "a");
		answer(h, "already_did_it", "b");
		expect(
			h
				.rows("reminderEvent")
				.filter((e) => e.state === "self_reported_complete"),
		).toHaveLength(1);
		expect(() => answer(h, "okay", "a")).toThrow(
			"clientId is already used for another request",
		);
	});

	test("other answers fail after prompts end", () => {
		const h = setup();
		answer(h, "stop", "a");
		expect(() => answer(h, "okay", "b")).toThrow(
			"prompts have ended for this occurrence",
		);
	});

	test("help on a meal asks the ladder with the wearer's words", () => {
		const h = setup({}, "meal");
		h.call(mod.setContactLadder, alice, {
			familyId: 1n,
			contacts: [
				{
					member: bob,
					name: "Bob",
					timeZone: "UTC",
					detail: { tag: "Summary" },
					callFor: [],
				},
			],
			backup: undefined,
			answerSeconds: 60,
			followUpSeconds: 60,
		});
		answer(h, "help", "a", "I feel dizzy");
		expect(h.rows("careNeed")).toMatchObject([
			{ summary: "Pills: I feel dizzy" },
		]);
	});

	test.each([
		[{ source: "speaker" }, "source must be phone, web, or glasses"],
		[{ wording: "x".repeat(2001) }, "wording must be at most 2000 characters"],
		[{ response: "maybe" }, "response is not a reminder response"],
		[{ occurrenceId: 9n }, "not a member of this family"],
	])("rejects %p", (bad, message) => {
		const h = setup();
		expect(() =>
			h.call(mod.answerReminder, alice, {
				occurrenceId: 1n,
				clientId: "c",
				source: "glasses",
				response: "okay",
				wording: "x".repeat(2000),
				...bad,
			}),
		).toThrow(message);
		expect(h.rows("reminderRequest")).toEqual([]);
	});
});

describe("confirmReminder", () => {
	const confirm = (h: H, clientId: string, wording?: string) =>
		h.call(mod.confirmReminder, bob, {
			occurrenceId: 1n,
			clientId,
			source: "web",
			wording,
		});

	test("a member confirms once; retries and repeats record nothing", () => {
		const h = setup();
		fire(h);
		confirm(h, "a", "saw her take it");
		confirm(h, "a", "saw her take it");
		confirm(h, "b");
		expect(occ(h)).toMatchObject({
			state: "caregiver_confirmed",
			promptDue: false,
			nextPromptAt: undefined,
		});
		expect(
			h.rows("reminderEvent").filter((e) => e.state === "caregiver_confirmed"),
		).toMatchObject([
			{ actor: bob, wording: "saw her take it", response: undefined },
		]);
		expect(() => confirm(h, "a")).toThrow(
			"clientId is already used for another request",
		);
		// The wearer's later "done" does not overwrite the caregiver's confirmation.
		answer(h, "done");
		expect(occ(h).state).toBe("caregiver_confirmed");
	});

	test("validates source, wording, and membership", () => {
		const h = setup();
		expect(() =>
			h.call(mod.confirmReminder, bob, {
				occurrenceId: 1n,
				clientId: "a",
				source: "speaker",
				wording: undefined,
			}),
		).toThrow("source must be phone, web, or glasses");
		expect(() => confirm(h, "a", "x".repeat(2001))).toThrow(
			"wording must be at most 2000 characters",
		);
		expect(() =>
			h.call(mod.confirmReminder, mallory, {
				occurrenceId: 1n,
				clientId: "a",
				source: "web",
				wording: undefined,
			}),
		).toThrow("not a member of this family");
	});
});

describe("setSpeakerSettings", () => {
	const speaker = {
		familyId: 1n,
		enabled: true,
		room: "shared",
		sharedRoomKinds: ["meal", "meal", "charging"],
	};

	test("stores deduplicated kinds, then updates; view shows members only", () => {
		const h = setup();
		h.call(mod.setSpeakerSettings, alice, speaker);
		expect(h.rows("speakerSettings")).toMatchObject([
			{ sharedRoomKinds: ["meal", "charging"], updatedBy: alice },
		]);
		h.call(mod.setSpeakerSettings, bob, {
			...speaker,
			room: "private",
			enabled: false,
		});
		expect(h.view(mod.mySpeakerSettings, alice)).toMatchObject([
			{ room: "private", enabled: false, updatedBy: bob },
		]);
		expect(h.view(mod.mySpeakerSettings, mallory)).toEqual([]);
	});

	test.each([
		[{ room: "kitchen" }, alice, "room must be private or shared"],
		[
			{ sharedRoomKinds: ["nap"] },
			alice,
			"sharedRoomKinds must be reminder kinds",
		],
		[{}, mallory, "not a member of this family"],
	])("rejects %p", (bad, who, message) => {
		const h = setup();
		expect(() =>
			h.call(mod.setSpeakerSettings, who, { ...speaker, ...bad }),
		).toThrow(message);
		expect(h.rows("speakerSettings")).toEqual([]);
	});
});
