import { beforeEach, describe, expect, test } from "bun:test";
import { at, harness, identity, mod } from "./test/harness.test";

const alice = identity(1);
const bob = identity(2);
const mallory = identity(3);

const family = () => {
	const h = harness("2026-01-05T12:00:00Z");
	h.call(mod.createFamily, alice, { name: "Rivera" });
	h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
	h.call(mod.createFamily, mallory, { name: "Other" });
	return h;
};
let h = family();
beforeEach(() => {
	h = family();
});

describe("reports", () => {
	const draft = { id: "r1", familyId: 1n, markers: "[]", fields: "{}" };

	test("a member creates a report that only members see", () => {
		h.call(mod.createReport, alice, draft);
		expect(h.view(mod.myReports, bob)).toMatchObject([
			{ id: "r1", createdBy: alice, reviewedAt: undefined },
		]);
		expect(h.view(mod.myReports, mallory)).toEqual([]);
	});

	test.each([
		[{ ...draft, familyId: 2n }, "not a member of this family"],
		[{ ...draft, id: " " }, "id must not be empty"],
		[{ ...draft, markers: "" }, "markers must not be empty"],
		[{ ...draft, fields: "" }, "fields must not be empty"],
	])("rejects bad input %#", (input, message) => {
		expect(() => h.call(mod.createReport, alice, input)).toThrow(message);
		expect(h.rows("report")).toEqual([]);
	});

	test("rejects a duplicate id", () => {
		h.call(mod.createReport, alice, draft);
		expect(() => h.call(mod.createReport, bob, draft)).toThrow(
			"report id already exists",
		);
	});

	test("update edits a draft; review freezes it; re-review keeps the first", () => {
		h.call(mod.createReport, alice, draft);
		h.call(mod.updateReport, bob, {
			id: "r1",
			fields: '{"a":1}',
			review: false,
		});
		expect(h.rows("report")[0]).toMatchObject({
			fields: '{"a":1}',
			reviewedAt: undefined,
		});
		h.call(mod.updateReport, alice, {
			id: "r1",
			fields: undefined,
			review: true,
		});
		const reviewed = h.rows("report")[0];
		expect(reviewed).toMatchObject({ fields: '{"a":1}', reviewedBy: alice });
		h.advance(60);
		h.call(mod.updateReport, bob, {
			id: "r1",
			fields: undefined,
			review: true,
		});
		expect(h.rows("report")[0]).toEqual(reviewed);
		for (const args of [
			{ id: "r1", fields: "{}", review: false },
			{ id: "r1", fields: "{}", review: true },
			{ id: "r1", fields: undefined, review: false },
		])
			expect(() => h.call(mod.updateReport, alice, args)).toThrow(
				"report is already reviewed",
			);
	});

	test("update rejects blank fields, missing ids, and outsiders alike", () => {
		h.call(mod.createReport, alice, draft);
		expect(() =>
			h.call(mod.updateReport, alice, { id: "r1", fields: " ", review: true }),
		).toThrow("fields must not be empty");
		for (const [who, id] of [
			[alice, "nope"],
			[mallory, "r1"],
		] as const)
			expect(() =>
				h.call(mod.updateReport, who, { id, fields: undefined, review: true }),
			).toThrow("not a member of this family");
		expect(h.rows("report")[0]).toMatchObject({ reviewedAt: undefined });
	});
});

describe("linkFinchnodeSubject", () => {
	test("links once per subject, visible to members only", () => {
		const link = { familyId: 1n, subject: "s1", synthetic: true };
		h.call(mod.linkFinchnodeSubject, alice, link);
		h.call(mod.linkFinchnodeSubject, bob, link);
		expect(h.view(mod.myFinchnodeLinks, bob)).toMatchObject([
			{ subject: "s1", linkedBy: alice, synthetic: true },
		]);
		expect(h.view(mod.myFinchnodeLinks, mallory)).toEqual([]);
	});

	test("rejects outsiders and blank subjects", () => {
		expect(() =>
			h.call(mod.linkFinchnodeSubject, mallory, {
				familyId: 1n,
				subject: "s",
				synthetic: false,
			}),
		).toThrow("not a member of this family");
		expect(() =>
			h.call(mod.linkFinchnodeSubject, alice, {
				familyId: 1n,
				subject: "",
				synthetic: false,
			}),
		).toThrow("subject must not be empty");
	});
});

describe("recordTripEvent", () => {
	const plan = {
		purpose: "shopping",
		destination: "market" as string | undefined,
		notifyDeparture: true,
		notifyArrival: true,
	};
	const step = (
		tripId: string,
		tag: string,
		extra: { source?: string; plan?: typeof plan } = {},
	) =>
		h.call(mod.recordTripEvent, alice, {
			familyId: 1n,
			tripId,
			step: { tag },
			source: extra.source ?? "manual",
			plan: extra.plan,
		});
	const steps = () =>
		h.view(mod.myTripEvents, bob).map((e) => `${e.tripId}:${e.step.tag}`);
	const bodies = () => h.rows("message").map((m) => m.body);

	test("full trip sends the chosen notices once each", () => {
		step("t1", "Asked");
		step("t1", "Asked"); // resend
		step("t1", "Leaving", { plan });
		step("t1", "Leaving", { plan }); // resend
		step("t1", "Leaving", { plan: { ...plan, destination: "park" } }); // changed plan
		step("t1", "Arrived");
		step("t1", "Arrived"); // resend
		expect(steps()).toEqual([
			"t1:Asked",
			"t1:Leaving",
			"t1:Leaving",
			"t1:Arrived",
		]);
		expect(bodies()).toEqual([
			"I'm leaving home: shopping (market).",
			"I arrived: park.",
		]);
		expect(h.rows("message").map((m) => m.clientId)).toEqual([
			"trip-t1-left",
			"trip-t1-arrived",
		]);
		expect(h.view(mod.myTripEvents, mallory)).toEqual([]);
	});

	test("notices follow the wearer's choices and fall back to purpose", () => {
		step("t1", "Asked");
		step("t1", "Leaving", {
			plan: { ...plan, destination: undefined, notifyDeparture: false },
		});
		step("t1", "Arrived");
		expect(bodies()).toEqual(["I arrived: shopping."]);
		h.advance(13 * 3600);
		step("t2", "Asked");
		step("t2", "Leaving", {
			plan: { ...plan, destination: undefined, notifyArrival: false },
		});
		step("t2", "Arrived");
		expect(bodies()).toEqual([
			"I arrived: shopping.",
			"I'm leaving home: shopping.",
		]);
	});

	test("cancel ends a trip; later steps are refused", () => {
		step("t1", "Asked");
		step("t1", "Cancelled");
		step("t1", "Cancelled");
		expect(() => step("t1", "Leaving", { plan })).toThrow("the trip has ended");
		expect(() => step("t1", "Arrived")).toThrow("the trip has ended");
		expect(steps()).toEqual(["t1:Asked", "t1:Cancelled"]);
		expect(bodies()).toEqual([]);
	});

	test.each([
		["Arrived", undefined, "the trip has not started"],
		["Leaving", undefined, "purpose is required"],
		["Leaving", { ...plan, purpose: " " }, "purpose must not be empty"],
	])("after Asked, %s %# is refused", (tag, p, message) => {
		step("t1", "Asked");
		expect(() => step("t1", tag, { plan: p })).toThrow(message);
		expect(steps()).toEqual(["t1:Asked"]);
	});

	test("rejects unknown trips, bad source, blank id, outsiders", () => {
		expect(() => step("t1", "Leaving", { plan })).toThrow("no such trip");
		expect(() => step("t1", "Asked", { source: "gps" })).toThrow(
			"source must be manual or departure_signal",
		);
		expect(() => step(" ", "Asked")).toThrow("tripId must not be empty");
		expect(() =>
			h.call(mod.recordTripEvent, mallory, {
				familyId: 1n,
				tripId: "t",
				step: { tag: "Asked" },
				source: "manual",
				plan: undefined,
			}),
		).toThrow("not a member of this family");
	});

	// Each case: a latest step, seconds later, a new question from a source; asked or not.
	test.each([
		["Asked", 29 * 60, "manual", false],
		["Asked", 30 * 60, "manual", true],
		["Leaving", 12 * 3600 - 1, "manual", false],
		["Leaving", 12 * 3600, "manual", true],
		["Cancelled", 60, "manual", true],
		["Cancelled", 29 * 60, "departure_signal", false],
		["Cancelled", 30 * 60, "departure_signal", true],
	] as const)(
		"after %s, %ds later a %s question asks: %p",
		(tag, secs, source, asks) => {
			step("t1", "Asked");
			if (tag !== "Asked") step("t1", tag, { plan });
			h.advance(secs);
			step("t2", "Asked", { source });
			expect(steps().includes("t2:Asked")).toBe(asks);
		},
	);
});

describe("location sharing", () => {
	const fix = (over: Record<string, unknown> = {}) => ({
		latitude: 40,
		longitude: -73,
		accuracyMeters: 5,
		fixTime: at("2026-01-05T12:00:00Z"),
		...over,
	});
	const report = (tag: string, f?: object) =>
		h.call(mod.reportLocation, alice, {
			familyId: 1n,
			status: { tag },
			fix: f,
		});

	test("share once; viewer sees the location; revoke deletes it", () => {
		expect(() => report("Fix", fix())).toThrow(
			"location is not shared with anyone",
		);
		h.call(mod.shareLocation, alice, { familyId: 1n, viewer: bob });
		h.call(mod.shareLocation, alice, { familyId: 1n, viewer: bob });
		expect(h.view(mod.myLocationShares, alice)).toHaveLength(1);
		expect(h.view(mod.myLocationShares, bob)).toMatchObject([
			{ sharer: alice, viewer: bob },
		]);
		report("Fix", fix());
		h.advance(60);
		report("NoFix");
		expect(h.rows("location")).toHaveLength(1);
		expect(h.view(mod.myLocations, bob)).toMatchObject([
			{
				status: { tag: "NoFix" },
				fix: { latitude: 40 },
				reportedAt: at("2026-01-05T12:01:00Z"),
			},
		]);
		expect(h.view(mod.myLocations, alice)).toHaveLength(1);
		expect(h.view(mod.myLocations, mallory)).toEqual([]);
		h.call(mod.revokeLocationShare, alice, { familyId: 1n, viewer: bob });
		expect(h.rows("locationShare")).toEqual([]);
		expect(h.rows("location")).toEqual([]);
	});

	test("revoking one of two viewers keeps the location", () => {
		const carol = identity(4);
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: carol });
		h.call(mod.shareLocation, alice, { familyId: 1n, viewer: bob });
		h.call(mod.shareLocation, alice, { familyId: 1n, viewer: carol });
		report("GpsDenied");
		h.call(mod.revokeLocationShare, alice, { familyId: 1n, viewer: bob });
		expect(h.view(mod.myLocations, bob)).toEqual([]);
		expect(h.view(mod.myLocations, carol)).toHaveLength(1);
	});

	test.each([
		[alice, alice, "viewer must be another family member"],
		[alice, mallory, "viewer is not a member of this family"],
		[mallory, alice, "not a member of this family"],
	])("shareLocation refuses %#", (sender, viewer, message) => {
		expect(() =>
			h.call(mod.shareLocation, sender, { familyId: 1n, viewer }),
		).toThrow(message);
	});

	test("revoke by an outsider fails", () => {
		expect(() =>
			h.call(mod.revokeLocationShare, mallory, { familyId: 1n, viewer: bob }),
		).toThrow("not a member of this family");
	});

	test.each([
		["Fix", undefined, "a fix is required exactly when status is Fix"],
		["NoFix", fix(), "a fix is required exactly when status is Fix"],
		["Fix", fix({ latitude: 90.1 }), "coordinates out of range"],
		["Fix", fix({ longitude: -180.1 }), "coordinates out of range"],
		["Fix", fix({ latitude: Number.NaN }), "coordinates out of range"],
		["Fix", fix({ accuracyMeters: 0 }), "accuracyMeters must be positive"],
		[
			"Fix",
			fix({ accuracyMeters: Number.POSITIVE_INFINITY }),
			"accuracyMeters must be positive",
		],
		[
			"Fix",
			fix({ fixTime: at("2026-01-05T12:01:01Z") }),
			"fixTime is in the future",
		],
	])("reportLocation %s refuses %#", (tag, f, message) => {
		h.call(mod.shareLocation, alice, { familyId: 1n, viewer: bob });
		expect(() => report(tag, f)).toThrow(message);
		expect(h.rows("location")).toEqual([]);
	});

	test("accepts boundary fixes up to one minute ahead", () => {
		h.call(mod.shareLocation, alice, { familyId: 1n, viewer: bob });
		report(
			"Fix",
			fix({
				latitude: -90,
				longitude: 180,
				fixTime: at("2026-01-05T12:01:00Z"),
			}),
		);
		expect(h.rows("location")).toMatchObject([
			{ fix: { latitude: -90, longitude: 180 } },
		]);
	});
});

describe("recordMealFact", () => {
	const grant = (scope: string) =>
		h.call(mod.setCareGrant, alice, {
			familyId: 1n,
			member: bob,
			scope,
			granted: true,
		});
	const meal = (fact: string) =>
		h.call(mod.recordMealFact, bob, { familyId: 1n, mealId: "m1", fact });

	test("needs health_records; view needs it too", () => {
		expect(() => meal('{"type":"note"}')).toThrow(
			"no care access: health_records",
		);
		grant("health_records");
		meal('{"type":"note"}');
		expect(h.view(mod.myMealFacts, bob)).toMatchObject([
			{ mealId: "m1", recordedBy: bob },
		]);
		expect(h.view(mod.myMealFacts, alice)).toEqual([]);
	});

	test.each([
		['{"type":"photo_taken"}', true],
		['{"type":"food_estimate","estimate":{"source":"photo"}}', true],
		['{"type":"food_estimate","estimate":{"source":"text"}}', false],
		['{"type":"food_estimate","estimate":null}', false],
		['{"type":"food_estimate"}', false],
	])("%s needs media: %p", (fact, needsMedia) => {
		grant("health_records");
		if (needsMedia) {
			expect(() => meal(fact)).toThrow("no care access: media");
			grant("media");
		}
		meal(fact);
		expect(h.rows("mealFact")).toHaveLength(1);
	});

	test.each([
		["nope", "fact must be JSON"],
		["null", "fact must have a type"],
		["3", "fact must have a type"],
		['{"a":1}', "fact must have a type"],
	])("rejects fact %s", (fact, message) => {
		grant("health_records");
		expect(() => meal(fact)).toThrow(message);
	});

	test("rejects blank mealId", () => {
		grant("health_records");
		expect(() =>
			h.call(mod.recordMealFact, bob, {
				familyId: 1n,
				mealId: " ",
				fact: "{}",
			}),
		).toThrow("mealId must not be empty");
	});
});

describe("medicine memory", () => {
	const seen = (over: Record<string, unknown> = {}) => ({
		familyId: 1n,
		container: "Aspirin",
		place: "kitchen",
		seenAt: at("2026-01-05T11:50:00Z"),
		source: "camera",
		confidence: 0.9,
		labelRead: true,
		...over,
	});
	const on = () =>
		h.call(mod.setMedicineMemory, alice, {
			familyId: 1n,
			enabled: true,
			places: ["kitchen"],
		});

	test("enable, update, disable wipes memory and sightings", () => {
		expect(() => h.call(mod.rememberMedicine, bob, seen())).toThrow(
			"medicine memory is off for this family",
		);
		on();
		h.call(mod.setMedicineMemory, bob, {
			familyId: 1n,
			enabled: true,
			places: ["bath"],
		});
		expect(h.view(mod.myMedicineMemory, alice)).toMatchObject([
			{ places: ["bath"], setBy: bob },
		]);
		expect(h.view(mod.myMedicineMemory, mallory)).toEqual([]);
		h.call(mod.rememberMedicine, bob, seen());
		h.call(mod.setMedicineMemory, alice, {
			familyId: 1n,
			enabled: false,
			places: [],
		});
		expect(h.rows("medicineMemory")).toEqual([]);
		expect(h.rows("medicineSighting")).toEqual([]);
	});

	test("setMedicineMemory rejects blank places and outsiders", () => {
		expect(() =>
			h.call(mod.setMedicineMemory, alice, {
				familyId: 1n,
				enabled: true,
				places: ["a", " "],
			}),
		).toThrow("place must not be empty");
		expect(() =>
			h.call(mod.setMedicineMemory, mallory, {
				familyId: 1n,
				enabled: false,
				places: [],
			}),
		).toThrow("not a member of this family");
	});

	test("a newer sighting of the same container replaces the old; older is refused", () => {
		on();
		h.call(mod.rememberMedicine, bob, seen());
		h.call(mod.rememberMedicine, bob, seen({ container: "Ibuprofen" }));
		h.call(mod.markMedicineNotFound, alice, { id: 1n });
		h.call(
			mod.rememberMedicine,
			alice,
			seen({
				container: " aspirin ",
				place: "bath",
				seenAt: at("2026-01-05T11:55:00Z"),
			}),
		);
		const sightings = h.view(mod.myMedicineSightings, bob);
		expect(sightings).toHaveLength(2);
		expect(sightings.find((s) => s.id === 1n)).toMatchObject({
			place: "bath",
			savedBy: alice,
			notFoundAt: undefined,
		});
		expect(sightings.find((s) => s.id === 2n)).toMatchObject({
			container: "Ibuprofen",
		});
		expect(() => h.call(mod.rememberMedicine, bob, seen())).toThrow(
			"a newer sighting is already stored",
		);
		expect(h.view(mod.myMedicineSightings, mallory)).toEqual([]);
	});

	test.each([
		[{ container: " " }, "container must not be empty"],
		[{ place: "" }, "place must not be empty"],
		[{ source: "" }, "source must not be empty"],
		[{ confidence: -0.1 }, "confidence must be between 0 and 1"],
		[{ confidence: 1.1 }, "confidence must be between 0 and 1"],
		[{ confidence: Number.NaN }, "confidence must be between 0 and 1"],
		[
			{ seenAt: at("2026-01-05T11:44:59Z") },
			"seenAt must be a current observation",
		],
		[
			{ seenAt: at("2026-01-05T12:01:01Z") },
			"seenAt must be a current observation",
		],
	])("rememberMedicine refuses %#", (over, message) => {
		on();
		expect(() => h.call(mod.rememberMedicine, bob, seen(over))).toThrow(
			message,
		);
		expect(h.rows("medicineSighting")).toEqual([]);
	});

	test.each([at("2026-01-05T11:45:00Z"), at("2026-01-05T12:01:00Z")])(
		"rememberMedicine accepts the window edge %#",
		(seenAt) => {
			on();
			h.call(mod.rememberMedicine, bob, seen({ seenAt, confidence: 0 }));
			expect(h.rows("medicineSighting")).toHaveLength(1);
		},
	);

	test("markMedicineNotFound marks; missing ids and outsiders fail alike", () => {
		on();
		h.call(mod.rememberMedicine, bob, seen());
		h.advance(30);
		h.call(mod.markMedicineNotFound, alice, { id: 1n });
		expect(h.rows("medicineSighting")[0]).toMatchObject({
			place: "kitchen",
			notFoundAt: at("2026-01-05T12:00:30Z"),
		});
		for (const [who, id] of [
			[alice, 9n],
			[mallory, 1n],
		] as const)
			expect(() => h.call(mod.markMedicineNotFound, who, { id })).toThrow(
				"not a member of this family",
			);
		expect(() => h.call(mod.rememberMedicine, mallory, seen())).toThrow(
			"not a member of this family",
		);
	});
});
