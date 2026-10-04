import { describe, expect, test } from "bun:test";
import { harness, identity, mod } from "./test/harness.test";

const alice = identity(1);
const bob = identity(2);
const mallory = identity(3);

// The slice of the harness the helpers below need; methods compare bivariantly.
type H = { call(reducer: unknown, sender: unknown, args: object): void };

// Alice founds family 1 and adds Bob; Mallory founds family 2.
const setup = () => {
	const h = harness("2026-01-05T12:00:00Z");
	h.call(mod.createFamily, alice, { name: "Rivera" });
	h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
	h.call(mod.createFamily, mallory, { name: "Other" });
	return h;
};

const grant = (
	h: H,
	by: typeof alice,
	member: typeof alice,
	scope: string,
	granted = true,
) => h.call(mod.setCareGrant, by, { familyId: 1n, member, scope, granted });

const instruction = (over: Record<string, unknown> = {}) => ({
	familyId: 1n,
	kind: "medication",
	name: "Metformin",
	instruction: "500mg with breakfast",
	times: ["08:00"],
	reason: undefined,
	source: "Dr. Lee",
	effectiveDate: "2026-01-01",
	...over,
});

const EVERY_SCOPE = [
	"care_plan_edit",
	"clinician_delivery",
	"family_access",
	"health_records",
	"location",
	"media",
	"purchases",
];

type GrantRow = {
	familyId: bigint;
	member: typeof alice;
	scope: string;
	granted: boolean;
	changedBy: typeof alice;
};

describe("setCareGrant", () => {
	test("a new family's founder holds every scope; other members hold none (#188)", () => {
		const h = setup();
		const start = h.rows("careGrantEvent").length;
		const family1 = h
			.rows<GrantRow>("careGrantEvent")
			.filter((row) => row.familyId === 1n);
		expect(family1.map((row) => row.scope).sort()).toEqual(EVERY_SCOPE);
		for (const row of family1)
			expect(row).toMatchObject({
				member: alice,
				granted: true,
				changedBy: alice,
			});
		expect(() => grant(h, bob, bob, "health_records")).toThrow(
			"no care access: family_access",
		);
		grant(h, alice, bob, "family_access");
		// The founder gives up family_access: she may no longer grant, but bob may.
		grant(h, alice, alice, "family_access", false);
		expect(() => grant(h, alice, alice, "family_access")).toThrow(
			"no care access: family_access",
		);
		grant(h, bob, alice, "family_access");
		grant(h, alice, bob, "media", false);
		expect(h.rows("careGrantEvent").slice(start)).toMatchObject([
			{ member: bob, scope: "family_access", granted: true, changedBy: alice },
			{
				member: alice,
				scope: "family_access",
				granted: false,
				changedBy: alice,
			},
			{ member: alice, scope: "family_access", granted: true, changedBy: bob },
			{ member: bob, scope: "media", granted: false, changedBy: alice },
		]);
	});

	test("in a family from before #188 (no grants), the founder may set up sharing until someone holds family_access", () => {
		const h = setup();
		// Such a family has no grant event at all; drop the ones `createFamily` now writes.
		const events = h.db.careGrantEvent as unknown as { rows: GrantRow[] };
		events.rows = events.rows.filter((row) => row.familyId !== 1n);
		expect(() => grant(h, bob, bob, "health_records")).toThrow(
			"no care access: family_access",
		);
		grant(h, alice, bob, "family_access");
		// Now alice holds nothing and family_access exists: she may no longer grant.
		expect(() => grant(h, alice, alice, "media")).toThrow(
			"no care access: family_access",
		);
		grant(h, bob, alice, "family_access");
		grant(h, alice, bob, "media", false);
		expect(
			h.rows<GrantRow>("careGrantEvent").filter((row) => row.familyId === 1n),
		).toMatchObject([
			{ member: bob, scope: "family_access", granted: true, changedBy: alice },
			{ member: alice, scope: "family_access", granted: true, changedBy: bob },
			{ member: bob, scope: "media", granted: false, changedBy: alice },
		]);
	});

	test.each([
		[mallory, bob, "media", "not a member of this family"],
		[alice, bob, "nope", "unknown care scope"],
		[alice, mallory, "media", "the grantee is not a member of this family"],
	])("rejects bad input %#", (by, member, scope, msg) => {
		const h = setup();
		const before = h.rows("careGrantEvent");
		expect(() => grant(h, by, member, scope)).toThrow(msg);
		expect(h.rows("careGrantEvent")).toEqual(before);
	});

	test("the latest event wins: revoke then regrant", () => {
		const h = setup();
		grant(h, alice, alice, "family_access");
		grant(h, alice, alice, "family_access", false);
		expect(() => grant(h, alice, bob, "media")).toThrow(
			"no care access: family_access",
		);
	});

	test("myCareGrants shows the family's grants to members only", () => {
		const h = setup();
		grant(h, alice, bob, "media");
		const byBob = h.view(mod.myCareGrants, bob) as unknown as GrantRow[];
		expect(byBob.filter((row) => row.member.isEqual(bob))).toMatchObject([
			{ scope: "media" },
		]);
		expect(byBob.every((row) => row.familyId === 1n)).toBe(true);
		// Mallory sees only her own family's grants: her founder grants.
		const byMallory = h.view(
			mod.myCareGrants,
			mallory,
		) as unknown as GrantRow[];
		expect(byMallory).toHaveLength(EVERY_SCOPE.length);
		expect(byMallory.every((row) => row.familyId === 2n)).toBe(true);
	});
});

describe("saveCareProfile", () => {
	test("needs care_plan_edit and a non-blank profile", () => {
		const h = setup();
		expect(() =>
			h.call(mod.saveCareProfile, bob, { familyId: 1n, profile: "{}" }),
		).toThrow("no care access: care_plan_edit");
		expect(() =>
			h.call(mod.saveCareProfile, mallory, { familyId: 1n, profile: "{}" }),
		).toThrow("not a member of this family");
		grant(h, alice, bob, "care_plan_edit");
		expect(() =>
			h.call(mod.saveCareProfile, bob, { familyId: 1n, profile: " " }),
		).toThrow("profile must not be empty");
		h.call(mod.saveCareProfile, bob, { familyId: 1n, profile: "{}" });
		expect(h.rows("careProfileVersion")).toMatchObject([
			{ id: 1n, familyId: 1n, profile: "{}", editedBy: bob },
		]);
	});

	test("myCareProfiles needs health_records; a revoke empties it at once", () => {
		const h = setup();
		grant(h, alice, alice, "family_access");
		grant(h, alice, alice, "care_plan_edit");
		h.call(mod.saveCareProfile, alice, { familyId: 1n, profile: "{}" });
		h.call(mod.addCareInstruction, alice, instruction());
		expect(h.view(mod.myCareProfiles, bob)).toEqual([]);
		grant(h, alice, bob, "health_records");
		expect(h.view(mod.myCareProfiles, bob)).toMatchObject([{ profile: "{}" }]);
		expect(h.view(mod.myCareInstructions, bob)).toMatchObject([
			{ name: "Metformin" },
		]);
		grant(h, alice, bob, "health_records", false);
		expect(h.view(mod.myCareProfiles, bob)).toEqual([]);
		expect(h.view(mod.myCareInstructions, bob)).toEqual([]);
		expect(h.view(mod.myCareProfiles, mallory)).toEqual([]);
	});
});

describe("care instructions", () => {
	const editor = () => {
		const h = setup();
		grant(h, alice, alice, "care_plan_edit");
		return h;
	};

	test.each([
		[{ kind: "food" }, "kind must be medication or care"],
		[{ name: " " }, "name must not be empty"],
		[{ instruction: "" }, "instruction must not be empty"],
		[{ source: "" }, "source must not be empty"],
		[{ effectiveDate: "" }, "effectiveDate must not be empty"],
	])("addCareInstruction rejects %o", (over, msg) => {
		const h = editor();
		expect(() =>
			h.call(mod.addCareInstruction, alice, instruction(over)),
		).toThrow(msg);
		expect(h.rows("careInstruction")).toEqual([]);
	});

	test("adds unverified; verify once; older cannot override newer verified", () => {
		const h = editor();
		expect(() => h.call(mod.addCareInstruction, bob, instruction())).toThrow(
			"no care access: care_plan_edit",
		);
		h.call(mod.addCareInstruction, alice, instruction({ reason: "diabetes" }));
		h.call(mod.addCareInstruction, alice, instruction({ name: "METFORMIN" }));
		h.call(mod.addCareInstruction, alice, instruction({ kind: "care" }));
		expect(h.rows("careInstruction")[0]).toMatchObject({
			id: 1n,
			reason: "diabetes",
			editedBy: alice,
			verifiedAt: undefined,
		});
		const second = () => h.rows("careInstruction").find((r) => r.id === 2n);
		h.call(mod.verifyCareInstruction, alice, { id: 2n });
		const verifiedAt = second()?.verifiedAt;
		expect(verifiedAt).toEqual(second()?.editedAt);
		h.advance(60);
		h.call(mod.verifyCareInstruction, alice, { id: 2n });
		expect(second()?.verifiedAt).toEqual(verifiedAt);
		expect(() => h.call(mod.verifyCareInstruction, alice, { id: 1n })).toThrow(
			"a newer version is already verified",
		);
		// A different kind with the same name is not a newer version.
		h.call(mod.verifyCareInstruction, alice, { id: 3n });
		expect(h.rows("careInstruction")[2]?.verifiedBy).toEqual(alice);
	});

	test("verify hides missing ids and needs care_plan_edit", () => {
		const h = editor();
		h.call(mod.addCareInstruction, alice, instruction());
		expect(() => h.call(mod.verifyCareInstruction, alice, { id: 9n })).toThrow(
			"not a member of this family",
		);
		expect(() => h.call(mod.verifyCareInstruction, bob, { id: 1n })).toThrow(
			"no care access: care_plan_edit",
		);
		expect(() =>
			h.call(mod.verifyCareInstruction, mallory, { id: 1n }),
		).toThrow("not a member of this family");
	});
});

describe("exercise plans", () => {
	const withPlan = (verify = true) => {
		const h = setup();
		h.call(mod.createExercisePlan, alice, {
			id: "p1",
			familyId: 1n,
			plan: "{}",
		});
		if (verify) h.call(mod.verifyExercisePlan, bob, { id: "p1" });
		return h;
	};
	const ev = (
		h: H,
		id: string,
		kind: string,
		reason?: string,
		sessionId = "s1",
		planId = "p1",
	) =>
		h.call(mod.recordExerciseEvent, bob, {
			id,
			planId,
			sessionId,
			kind,
			reason,
		});

	test("createExercisePlan validates and rejects duplicate ids", () => {
		const h = withPlan(false);
		expect(h.rows("exercisePlan")).toMatchObject([
			{ id: "p1", createdBy: alice, verifiedAt: undefined },
		]);
		expect(() =>
			h.call(mod.createExercisePlan, alice, {
				id: "p1",
				familyId: 1n,
				plan: "x",
			}),
		).toThrow("exercise plan id already exists");
		expect(() =>
			h.call(mod.createExercisePlan, alice, {
				id: " ",
				familyId: 1n,
				plan: "x",
			}),
		).toThrow("id must not be empty");
		expect(() =>
			h.call(mod.createExercisePlan, alice, {
				id: "p2",
				familyId: 1n,
				plan: "",
			}),
		).toThrow("plan must not be empty");
		expect(() =>
			h.call(mod.createExercisePlan, mallory, {
				id: "p2",
				familyId: 1n,
				plan: "x",
			}),
		).toThrow("not a member of this family");
	});

	test("verify keeps the first verification; hides missing and foreign plans", () => {
		const h = withPlan();
		const first = h.rows("exercisePlan")[0]?.verifiedAt;
		h.advance(60);
		h.call(mod.verifyExercisePlan, alice, { id: "p1" });
		expect(h.rows("exercisePlan")[0]).toMatchObject({ verifiedBy: bob });
		expect(h.rows("exercisePlan")[0]?.verifiedAt).toEqual(first);
		for (const [who, id] of [
			[alice, "nope"],
			[mallory, "p1"],
		] as const)
			expect(() => h.call(mod.verifyExercisePlan, who, { id })).toThrow(
				"not a member of this family",
			);
		expect(h.view(mod.myExercisePlans, alice)).toHaveLength(1);
		expect(h.view(mod.myExercisePlans, mallory)).toEqual([]);
	});

	test("an unverified plan records nothing", () => {
		const h = withPlan(false);
		expect(() => ev(h, "e1", "started")).toThrow(
			"the exercise plan is not verified",
		);
		expect(h.rows("exerciseEvent")).toEqual([]);
	});

	test("a started session takes controls until a stop with a reason ends it", () => {
		const h = withPlan();
		ev(h, "e1", "started");
		for (const [i, k] of [
			"paused",
			"resumed",
			"repeated",
			"slowed",
			"help",
		].entries())
			ev(h, `c${i}`, k);
		ev(h, "e2", "stopped", "pain");
		expect(() => ev(h, "e3", "paused")).toThrow(
			"paused is not allowed in this session now",
		);
		expect(() => ev(h, "e4", "started")).toThrow(
			"started is not allowed in this session now",
		);
		expect(h.rows("exerciseEvent")).toHaveLength(7);
		expect(h.rows("exerciseEvent")[6]).toMatchObject({
			kind: "stopped",
			reason: "pain",
			familyId: 1n,
			actor: bob,
		});
		expect(h.view(mod.myExerciseEvents, alice)).toHaveLength(7);
		expect(h.view(mod.myExerciseEvents, mallory)).toEqual([]);
	});

	test.each([
		["stopped", undefined],
		["stopped", "boredom"],
		["completed", "pain"],
	])("rejects %s with reason %p", (kind, reason) => {
		const h = withPlan();
		ev(h, "e1", "started");
		expect(() => ev(h, "e2", kind, reason)).toThrow(
			"only a stop has a reason: wearer, pain, dizziness, or distress",
		);
	});

	test("declined ends a session; controls need a started one; unknown kinds fail", () => {
		const h = withPlan();
		expect(() => ev(h, "e0", "paused")).toThrow("paused is not allowed");
		ev(h, "e1", "declined");
		expect(() => ev(h, "e2", "completed")).toThrow("completed is not allowed");
		ev(h, "e3", "started", undefined, "s2");
		expect(() => ev(h, "e4", "dance", undefined, "s2")).toThrow(
			"dance is not allowed",
		);
		ev(h, "e5", "completed", undefined, "s2");
		expect(h.rows("exerciseEvent").map((e) => e.kind)).toEqual([
			"declined",
			"started",
			"completed",
		]);
	});

	test("a resend is idempotent; a reused id or foreign session fails", () => {
		const h = withPlan();
		h.call(mod.createExercisePlan, alice, {
			id: "p2",
			familyId: 1n,
			plan: "{}",
		});
		h.call(mod.verifyExercisePlan, alice, { id: "p2" });
		ev(h, "e1", "started");
		ev(h, "e1", "started");
		expect(h.rows("exerciseEvent")).toHaveLength(1);
		expect(() => ev(h, "e1", "declined")).toThrow(
			"id is already used for another event",
		);
		expect(() => ev(h, "e2", "paused", undefined, "s1", "p2")).toThrow(
			"the session belongs to another plan",
		);
		expect(() => ev(h, " ", "started")).toThrow("id must not be empty");
		expect(() => ev(h, "e3", "started", undefined, "")).toThrow(
			"sessionId must not be empty",
		);
	});
});

describe("recordDeliveryEvent", () => {
	const rec = (
		h: H,
		status: string,
		proposal?: string,
		by = alice,
		familyId = 1n,
		proposalId = "o1",
	) =>
		h.call(mod.recordDeliveryEvent, by, {
			familyId,
			proposalId,
			status: { tag: status } as never,
			proposal,
			note: "",
		});

	test("walks the happy path with retries", () => {
		const h = setup();
		rec(h, "Proposed", "{}");
		for (const s of [
			"Approved",
			"Uncertain",
			"Uncertain",
			"Failed",
			"Placed",
			"Delivered",
			"Eaten",
		])
			rec(h, s);
		expect(h.rows("deliveryEvent").map((r) => r.status.tag)).toEqual([
			"Proposed",
			"Approved",
			"Uncertain",
			"Uncertain",
			"Failed",
			"Placed",
			"Delivered",
			"Eaten",
		]);
		expect(h.view(mod.myDeliveryEvents, bob)).toHaveLength(8);
		expect(h.view(mod.myDeliveryEvents, mallory)).toEqual([]);
	});

	test.each([
		[["Proposed"], "Placed", "a Proposed proposal cannot become Placed"],
		[["Proposed"], "Eaten", "a Proposed proposal cannot become Eaten"],
		[
			["Proposed", "Approved"],
			"Delivered",
			"a Approved proposal cannot become Delivered",
		],
		[
			["Proposed", "Replaced"],
			"Approved",
			"a Replaced proposal cannot become Approved",
		],
		[[], "Approved", "a missing proposal cannot become Approved"],
	])("after %p, %s fails", (before, status, msg) => {
		const h = setup();
		for (const s of before) rec(h, s, s === "Proposed" ? "{}" : undefined);
		expect(() => rec(h, status)).toThrow(msg);
		expect(h.rows("deliveryEvent")).toHaveLength(before.length);
	});

	test("rejects bad proposals, outsiders, and other families' ids", () => {
		const h = setup();
		expect(() => rec(h, "Proposed")).toThrow(
			"only a new proposal carries proposal JSON",
		);
		expect(() => rec(h, "Approved", "{}")).toThrow(
			"only a new proposal carries proposal JSON",
		);
		expect(() => rec(h, "Proposed", " ")).toThrow("proposal must not be empty");
		expect(() => rec(h, "Proposed", "{}", alice, 1n, "")).toThrow(
			"proposalId must not be empty",
		);
		expect(() => rec(h, "Proposed", "{}", mallory)).toThrow(
			"not a member of this family",
		);
		rec(h, "Proposed", "{}");
		expect(() => rec(h, "Proposed", "{}")).toThrow(
			"proposal id already exists",
		);
		expect(() => rec(h, "Approved", undefined, mallory, 2n)).toThrow(
			"proposal id already exists",
		);
		rec(h, "Replaced");
		expect(h.rows("deliveryEvent")).toHaveLength(2);
	});
});
