import { describe, expect, test } from "bun:test";
import { at, harness, identity, MODULE, mod } from "./test/harness.test";

const alice = identity(1);
const bob = identity(2);
const carol = identity(3);
const mallory = identity(9);

type Detail = "Minimal" | "Summary" | "Facts";
const step = (
	member: typeof alice,
	name: string,
	detail: Detail = "Summary",
	callFor: string[] = [],
) => ({
	member,
	name,
	timeZone: "America/Chicago",
	detail: { tag: detail },
	callFor: callFor.map((tag) => ({ tag })),
});

const ladder = (over: Record<string, unknown> = {}) => ({
	familyId: 1n,
	contacts: [step(bob, "Bob", "Facts", ["Alert"]), step(carol, "Carol")],
	backup: undefined,
	answerSeconds: 60,
	followUpSeconds: 600,
	...over,
});

type H = ReturnType<typeof harness>;

const family = (): H => {
	const h = harness("2026-01-05T12:00:00Z");
	h.call(mod.createFamily, alice, { name: "Rivera" });
	for (const m of [bob, carol])
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: m });
	return h;
};

const withLadder = (over: Record<string, unknown> = {}) => {
	const h = family();
	h.call(mod.setContactLadder, alice, ladder(over));
	return h;
};

const help = (over: Record<string, unknown> = {}) => ({
	familyId: 1n,
	clientId: "c1",
	kind: { tag: "Help" },
	summary: "Mum needs a lift",
	sampleIds: [],
	dueAt: undefined,
	...over,
});

const respond = (h: H, who: typeof alice, tag: string) =>
	h.call(mod.respondToCareNeed, who, { needId: 1n, response: { tag } });

// Runs every stored timer due by now, as the scheduler would.
const tick = (h: H, seconds: number) => {
	h.advance(seconds);
	const now = h.now.microsSinceUnixEpoch;
	for (const timer of h.rows("ladderTimer") as {
		scheduledAt: { value: { microsSinceUnixEpoch: bigint } };
	}[])
		if (timer.scheduledAt.value.microsSinceUnixEpoch <= now)
			h.call(mod.runLadderTimer, MODULE, { timer });
};

type Tagged = { tag: string };
const need = (h: H) =>
	h.rows<{ status: Tagged; facts: unknown[] }>("careNeed")[0];
const attempts = (h: H) =>
	h
		.rows<{ step: number; channel: Tagged; status: Tagged }>("contactAttempt")
		.map((a) => [a.step, a.channel.tag, a.status.tag]);
const chat = (h: H) =>
	(h.rows("message") as { body: string }[]).map((m) => m.body);

describe("setContactLadder", () => {
	test("stores then replaces the family ladder; members see it, outsiders do not", () => {
		const h = withLadder();
		h.call(mod.setContactLadder, bob, ladder({ answerSeconds: 30 }));
		expect(h.rows("contactLadder")).toMatchObject([
			{ familyId: 1n, answerSeconds: 30, updatedBy: bob },
		]);
		expect(h.view(mod.myContactLadders, carol)).toHaveLength(1);
		expect(h.view(mod.myContactLadders, mallory)).toEqual([]);
	});

	const five = [alice, bob, carol, identity(4), identity(5), identity(6)];
	test.each([
		["no contacts", { contacts: [] }, "a ladder has 1 to 5 contacts"],
		[
			"six contacts",
			{ contacts: five.map((m, i) => step(m, `P${i}`)) },
			"a ladder has 1 to 5 contacts",
		],
		[
			"answer too short",
			{ answerSeconds: 9 },
			"answerSeconds must be 10 to 86400",
		],
		[
			"answer too long",
			{ answerSeconds: 86_401 },
			"answerSeconds must be 10 to 86400",
		],
		[
			"follow-up too short",
			{ followUpSeconds: 9 },
			"followUpSeconds must be 10 to 604800",
		],
		[
			"follow-up too long",
			{ followUpSeconds: 604_801 },
			"followUpSeconds must be 10 to 604800",
		],
		["blank name", { contacts: [step(bob, " ")] }, "name must not be empty"],
		[
			"blank time zone",
			{ contacts: [{ ...step(bob, "Bob"), timeZone: "" }] },
			"timeZone must not be empty",
		],
		[
			"non-member contact",
			{ contacts: [step(mallory, "M")] },
			"every contact must be a member of this family",
		],
		[
			"backup repeats a contact",
			{ contacts: [step(bob, "Bob")], backup: step(bob, "Bob") },
			"a member appears in the ladder once",
		],
	])("rejects %s", (_, over, error) => {
		const h = family();
		expect(() => h.call(mod.setContactLadder, alice, ladder(over))).toThrow(
			error,
		);
		expect(h.rows("contactLadder")).toEqual([]);
	});

	test("accepts the boundaries and an outsider cannot set it", () => {
		const h = family();
		h.call(
			mod.setContactLadder,
			alice,
			ladder({ answerSeconds: 10, followUpSeconds: 604_800 }),
		);
		h.call(
			mod.setContactLadder,
			alice,
			ladder({ answerSeconds: 86_400, followUpSeconds: 10 }),
		);
		expect(h.rows("contactLadder")).toHaveLength(1);
		expect(() => h.call(mod.setContactLadder, mallory, ladder())).toThrow(
			"not a member of this family",
		);
	});
});

describe("openCareNeed", () => {
	test("messages the first contact at once with a Summary notice", () => {
		const h = withLadder({ contacts: [step(carol, "Carol")] });
		h.call(mod.openCareNeed, alice, help());
		expect(need(h)).toMatchObject({
			status: { tag: "Open" },
			step: 0,
			hasBackup: false,
			raisedBy: alice,
		});
		const [attempt] = h.rows<{ body: string }>("contactAttempt");
		expect(attempt).toMatchObject({
			key: "1/0",
			member: carol,
			channel: { tag: "Message" },
			status: { tag: "Sent" },
		});
		expect(attempt?.body).toBe(
			"Telly asks Carol to take on a request for help. Open Care in Telly to accept or decline.\nMum needs a lift",
		);
		expect(chat(h)).toEqual([
			"Message for Carol: Telly needs someone to take on a request for help. Open Care in Telly to respond.",
		]);
		expect(h.rows("ladderTimer")).toMatchObject([
			{ needId: 1n, step: 0, purpose: { tag: "AnswerDue" } },
		]);
		expect(h.view(mod.myCareNeeds, bob)).toHaveLength(1);
		expect(h.view(mod.myContactAttempts, bob)).toHaveLength(1);
		expect(h.view(mod.myCareNeeds, mallory)).toEqual([]);
		expect(h.view(mod.myContactAttempts, mallory)).toEqual([]);
	});

	test("a Minimal notice omits the summary; Facts lists the samples", () => {
		const h = withLadder({
			contacts: [step(bob, "Bob", "Minimal")],
			backup: step(carol, "Carol", "Facts"),
		});
		h.db.healthSample.insert({
			id: 0n,
			familyId: 1n,
			metric: "heart_rate",
			value: 130,
			unit: "bpm",
			sourceTime: at("2026-01-05T11:59:00Z"),
			receivedAt: at("2026-01-05T11:59:00Z"),
			source: "watch",
			synthetic: true,
			quality: { tag: "Validated" },
			recordedBy: alice,
		});
		h.call(mod.openCareNeed, alice, help({ sampleIds: [1n] }));
		expect(need(h)).toMatchObject({
			hasBackup: true,
			steps: [{ name: "Bob" }, { name: "Carol" }],
		});
		const first = h.rows("contactAttempt")[0] as { body: string };
		expect(first.body).toBe(
			"Telly asks Bob to take on a request for help. Open Care in Telly to accept or decline.",
		);
		respond(h, bob, "Decline");
		const second = h.rows("contactAttempt")[1] as { body: string };
		expect(second.body.split("\n")).toEqual([
			"Telly asks Carol to take on a request for help. Open Care in Telly to accept or decline.",
			"Mum needs a lift",
			"heart_rate 130 bpm (watch, 2026-01-05T11:59:00.000000Z, synthetic demo data, validated signal)",
		]);
	});

	test("a future due time waits for the Send timer", () => {
		const h = withLadder();
		h.call(
			mod.openCareNeed,
			alice,
			help({
				kind: { tag: "CallReminder" },
				dueAt: at("2026-01-05T13:00:00Z"),
			}),
		);
		expect(attempts(h)).toEqual([[0, "Message", "Queued"]]);
		expect(h.rows("ladderTimer")).toMatchObject([{ purpose: { tag: "Send" } }]);
		tick(h, 3599);
		expect(attempts(h)).toEqual([[0, "Message", "Queued"]]);
		tick(h, 1);
		expect(attempts(h)).toEqual([[0, "Message", "Sent"]]);
		expect(chat(h)[0]).toContain("a call reminder");
	});

	test("without a ladder the need is unresolved at once", () => {
		const h = family();
		h.call(mod.openCareNeed, alice, help());
		expect(need(h)).toMatchObject({
			status: { tag: "Unresolved" },
			steps: [],
			answerSeconds: 0,
		});
		expect(h.rows("contactAttempt")).toEqual([]);
		expect(chat(h)).toEqual([
			"Nobody has taken on a request for help yet. It stays open in Care.",
		]);
	});

	test("a resend with the same clientId is a no-op; another summary is rejected", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		h.call(mod.openCareNeed, alice, help());
		expect(h.rows("careNeed")).toHaveLength(1);
		expect(() =>
			h.call(mod.openCareNeed, alice, help({ summary: "Other" })),
		).toThrow("clientId is already used for another need");
	});

	test.each([
		[mallory, {}, "not a member of this family"],
		[alice, { clientId: " " }, "clientId must not be empty"],
		[alice, { summary: "" }, "summary must not be empty"],
		[alice, { kind: { tag: "Alert" } }, "alerts open their own care need"],
		[alice, { sampleIds: [7n] }, "sample does not belong to this family"],
	])("rejects bad input %#", (who, over, error) => {
		const h = withLadder();
		expect(() => h.call(mod.openCareNeed, who, help(over))).toThrow(error);
		expect(h.rows("careNeed")).toEqual([]);
	});
});

describe("alert needs", () => {
	test("an alert calls a contact who wants calls; a second alert appends facts", () => {
		const h = withLadder();
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: undefined,
			summary: "Fall",
		});
		expect(need(h)).toMatchObject({
			kind: { tag: "Alert" },
			alertId: 1n,
			clientId: "alert-1",
			facts: [],
		});
		expect(attempts(h)).toEqual([[0, "Call", "Sent"]]);
		expect(chat(h)[0]).toStartWith("Calling (simulated) Bob:");
		h.db.healthSample.insert({
			id: 0n,
			familyId: 1n,
			metric: "spo2",
			value: 88,
			unit: "%",
			sourceTime: h.now,
			receivedAt: h.now,
			source: "ring",
			synthetic: false,
			quality: { tag: "Unvalidated" },
			recordedBy: alice,
		});
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: 1n,
			summary: "Low",
		});
		expect(h.rows("careNeed")).toHaveLength(1);
		expect(need(h).facts).toMatchObject([
			{ text: "spo2 88 %", uncertainty: "unvalidated signal" },
		]);
		expect(h.rows("contactAttempt")).toHaveLength(1);
	});

	test("an alert opens a new need once the earlier one is resolved; none without a ladder", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: undefined,
			summary: "A",
		});
		respond(h, bob, "Accept");
		h.call(mod.respondToCareNeed, bob, {
			needId: 2n,
			response: { tag: "Accept" },
		});
		h.call(mod.respondToCareNeed, bob, {
			needId: 2n,
			response: { tag: "ConfirmHelp" },
		});
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: undefined,
			summary: "B",
		});
		expect(h.rows("careNeed")).toHaveLength(3);
		const bare = family();
		bare.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: undefined,
			summary: "A",
		});
		expect(bare.rows("careNeed")).toEqual([]);
	});
});

describe("respondToCareNeed", () => {
	test("Seen and Answer record progress on a call without accepting", () => {
		const h = withLadder();
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: undefined,
			summary: "Fall",
		});
		respond(h, bob, "Seen");
		expect(attempts(h)).toEqual([[0, "Call", "Delivered"]]);
		respond(h, bob, "Seen");
		respond(h, bob, "Answer");
		respond(h, bob, "Answer");
		expect(attempts(h)).toEqual([[0, "Call", "Answered"]]);
		expect(need(h).status.tag).toBe("Open");
	});

	test("Answer on a message is rejected", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		expect(() => respond(h, bob, "Answer")).toThrow(
			"this contact was sent a message, not a call",
		);
	});

	test("accept stops the ladder; repeat accept and confirm are no-ops", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		respond(h, bob, "Accept");
		respond(h, bob, "Accept");
		expect(need(h)).toMatchObject({
			status: { tag: "Accepted" },
			acceptedBy: bob,
			followUpBy: at("2026-01-05T12:10:00Z"),
		});
		expect(chat(h)).toHaveLength(2);
		expect(chat(h)[1]).toBe(
			"Bob accepted a request for help. Telly contacts nobody else unless help is not confirmed in time.",
		);
		tick(h, 60); // AnswerDue passes; need is Accepted so nothing moves
		expect(attempts(h)).toEqual([[0, "Message", "Accepted"]]);
		expect(() => respond(h, carol, "ConfirmHelp")).toThrow(
			"only the member who accepted can confirm help",
		);
		respond(h, bob, "ConfirmHelp");
		respond(h, bob, "ConfirmHelp");
		expect(need(h)).toMatchObject({
			status: { tag: "Resolved" },
			followUpBy: undefined,
		});
		expect(chat(h).at(-1)).toBe("Bob confirmed help with a request for help.");
		tick(h, 600); // follow-up after resolution does nothing
		expect(need(h).status.tag).toBe("Resolved");
	});

	test("confirming before anyone accepted is rejected", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		expect(() => respond(h, bob, "ConfirmHelp")).toThrow(
			"only the member who accepted can confirm help",
		);
	});

	test("decline moves to the next contact, then past the last one is unresolved", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		respond(h, bob, "Decline");
		expect(need(h)).toMatchObject({ step: 1, status: { tag: "Open" } });
		expect(() => respond(h, bob, "Decline")).toThrow(
			"not the current contact for this need",
		);
		respond(h, carol, "Decline");
		expect(need(h)).toMatchObject({ step: 2, status: { tag: "Unresolved" } });
		expect(attempts(h)).toEqual([
			[0, "Message", "Declined"],
			[1, "Message", "Declined"],
		]);
		expect(() => respond(h, carol, "Accept")).toThrow(
			"not the current contact for this need",
		);
	});

	test.each([
		[mallory, 1n, "not a member of this family"],
		[bob, 99n, "not a member of this family"],
		[carol, 1n, "not the current contact for this need"],
	])("rejects %#", (who, needId, error) => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		expect(() =>
			h.call(mod.respondToCareNeed, who, {
				needId,
				response: { tag: "Accept" },
			}),
		).toThrow(error);
	});

	test("a queued (not yet sent) attempt cannot be accepted", () => {
		const h = withLadder();
		h.call(
			mod.openCareNeed,
			alice,
			help({ dueAt: at("2026-01-05T13:00:00Z") }),
		);
		expect(() => respond(h, bob, "Accept")).toThrow(
			"this need is not waiting for you",
		);
	});
});

describe("runLadderTimer", () => {
	test("only the database runs it", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		const [timer] = h.rows("ladderTimer");
		expect(() => h.call(mod.runLadderTimer, alice, { timer })).toThrow(
			"only the database runs ladder timers",
		);
	});

	test("no answer escalates to the next contact; an answered call too", () => {
		const h = withLadder({
			contacts: [step(bob, "Bob", "Summary", ["Alert"]), step(carol, "Carol")],
		});
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: undefined,
			summary: "Fall",
		});
		respond(h, bob, "Answer");
		tick(h, 60);
		expect(attempts(h)).toEqual([
			[0, "Call", "Answered"],
			[1, "Message", "Sent"],
		]);
		tick(h, 60);
		expect(attempts(h)[1]).toEqual([1, "Message", "NoAnswer"]);
		expect(need(h)).toMatchObject({ step: 2, status: { tag: "Unresolved" } });
		// stale timers for old steps are ignored
		tick(h, 60);
		expect(need(h).step).toBe(2);
		expect(chat(h).at(-1)).toBe(
			"Nobody has taken on a health alert yet. It stays open in Care.",
		);
	});

	test("an expired follow-up asks the next contact", () => {
		const h = withLadder();
		h.call(mod.openCareNeed, alice, help());
		respond(h, bob, "Accept");
		tick(h, 600);
		expect(attempts(h)).toEqual([
			[0, "Message", "FollowUpExpired"],
			[1, "Message", "Sent"],
		]);
		expect(need(h)).toMatchObject({
			step: 1,
			status: { tag: "Open" },
			acceptedBy: undefined,
		});
		expect(chat(h)).toContain(
			"Bob has not confirmed help with a request for help. Telly is asking the next contact.",
		);
	});

	test("a timer for a missing need or attempt does nothing", () => {
		const h = withLadder();
		h.call(
			mod.openCareNeed,
			alice,
			help({ dueAt: at("2026-01-05T13:00:00Z") }),
		);
		const [timer] = h.rows("ladderTimer") as Record<string, unknown>[];
		h.call(mod.runLadderTimer, MODULE, { timer: { ...timer, needId: 9n } });
		h.db.contactAttempt.key.delete("1/0");
		h.call(mod.runLadderTimer, MODULE, { timer });
		expect(chat(h)).toEqual([]);
	});

	test("a Send timer for a closed need sends nothing", () => {
		const h = withLadder();
		h.call(
			mod.openCareNeed,
			alice,
			help({ dueAt: at("2026-01-05T13:00:00Z") }),
		);
		h.db.careNeed.id.update({ ...need(h), status: { tag: "Resolved" } });
		tick(h, 3600);
		expect(attempts(h)).toEqual([[0, "Message", "Queued"]]);
	});
});
