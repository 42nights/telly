import { beforeEach, describe, expect, test } from "bun:test";
import { Identity } from "spacetimedb";
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
	const grantLocation = (member: typeof bob) =>
		h.call(mod.setCareGrant, alice, {
			familyId: 1n,
			member,
			scope: "location",
			granted: true,
		});

	test("share once; viewer sees the location only with the location scope; revoke deletes it", () => {
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
		// A share without the viewer's `location` scope (#26) shows nothing.
		expect(h.view(mod.myLocations, bob)).toEqual([]);
		grantLocation(bob);
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
		grantLocation(bob);
		grantLocation(carol);
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
		// The founder holds health_records (#188); once she gives it up, she sees no meal facts.
		expect(h.view(mod.myMealFacts, alice)).toMatchObject([{ mealId: "m1" }]);
		h.call(mod.setCareGrant, alice, {
			familyId: 1n,
			member: alice,
			scope: "health_records",
			granted: false,
		});
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
	// Alice founded family 1 and holds every scope; Bob is a member without care scopes.
	const seen = (over: Record<string, unknown> = {}) => ({
		familyId: 1n,
		personId: bob,
		container: "Aspirin",
		place: "kitchen",
		seenAt: at("2026-01-05T11:50:00Z"),
		source: "camera",
		confidence: 0.9,
		labelRead: true,
		category: "medicine",
		thumbnail: "",
		...over,
	});
	const on = (personId = bob, places = ["kitchen"]) =>
		h.call(mod.setMedicineMemory, personId, {
			familyId: 1n,
			personId,
			enabled: true,
			places,
		});
	const carol = identity(4);
	const caregiver = (granted: boolean) =>
		h.call(mod.setCareGrant, alice, {
			familyId: 1n,
			member: carol,
			scope: "care_plan_edit",
			granted,
		});

	test("each member's places and sightings are their own; disabling wipes only theirs", () => {
		expect(() => h.call(mod.rememberMedicine, bob, seen())).toThrow(
			"medicine memory is off for this member",
		);
		on();
		on(alice, ["bath"]);
		h.call(mod.rememberMedicine, bob, seen());
		h.call(mod.rememberMedicine, alice, seen({ personId: alice }));
		expect(h.view(mod.myMedicinePlaces, bob)).toMatchObject([
			{ personId: bob, places: ["kitchen"], setBy: bob },
		]);
		expect(h.view(mod.myMedicineSightings, bob)).toMatchObject([
			{ personId: bob, container: "Aspirin" },
		]);
		expect(h.view(mod.myMedicinePlaces, mallory)).toEqual([]);
		expect(h.view(mod.myMedicineSightings, mallory)).toEqual([]);

		h.call(mod.setMedicineMemory, bob, {
			familyId: 1n,
			personId: bob,
			enabled: false,
			places: [],
		});
		expect(h.rows("medicinePlaces")).toMatchObject([{ personId: alice }]);
		expect(h.rows("medicineSighting")).toMatchObject([{ personId: alice }]);
	});

	test("a member without care scopes cannot read or change another member's", () => {
		on(alice);
		h.call(mod.rememberMedicine, alice, seen({ personId: alice }));
		expect(h.view(mod.myMedicinePlaces, bob)).toEqual([]);
		expect(h.view(mod.myMedicineSightings, bob)).toEqual([]);
		for (const write of [
			() =>
				h.call(mod.setMedicineMemory, bob, {
					familyId: 1n,
					personId: alice,
					enabled: false,
					places: [],
				}),
			() => h.call(mod.rememberMedicine, bob, seen({ personId: alice })),
			() => h.call(mod.markMedicineNotFound, bob, { id: 1n }),
		])
			expect(write).toThrow("no care access:");
		expect(h.rows("medicineSighting")).toMatchObject([
			{ personId: alice, notFoundAt: undefined },
		]);
	});

	test("a caregiver manages every member's until the scope is revoked; the founder too", () => {
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: carol });
		caregiver(true);
		h.call(mod.setMedicineMemory, carol, {
			familyId: 1n,
			personId: bob,
			enabled: true,
			places: ["hall"],
		});
		h.call(mod.rememberMedicine, carol, seen());
		h.call(mod.markMedicineNotFound, alice, { id: 1n });
		expect(h.view(mod.myMedicineSightings, carol)).toMatchObject([
			{ personId: bob, savedBy: carol },
		]);
		expect(h.view(mod.myMedicinePlaces, alice)).toMatchObject([
			{ personId: bob, places: ["hall"], setBy: carol },
		]);
		caregiver(false);
		expect(h.view(mod.myMedicineSightings, carol)).toEqual([]);
		expect(() => h.call(mod.rememberMedicine, carol, seen())).toThrow(
			"no care access:",
		);
	});

	test("outsiders and non-member people are refused", () => {
		on();
		expect(() =>
			h.call(mod.setMedicineMemory, alice, {
				familyId: 1n,
				personId: mallory,
				enabled: true,
				places: [],
			}),
		).toThrow("not a member of this family");
		expect(() =>
			h.call(mod.setMedicineMemory, mallory, {
				familyId: 1n,
				personId: mallory,
				enabled: false,
				places: [],
			}),
		).toThrow("not a member of this family");
		expect(() =>
			h.call(mod.rememberMedicine, mallory, seen({ personId: mallory })),
		).toThrow("not a member of this family");
		expect(() => on(bob, ["a", " "])).toThrow("place must not be empty");
	});

	test("a newer sighting of the same container replaces the old; older is refused", () => {
		on();
		on(alice);
		h.call(mod.rememberMedicine, bob, seen());
		h.call(mod.rememberMedicine, bob, seen({ container: "Ibuprofen" }));
		// Alice's own aspirin is a separate container.
		h.call(mod.rememberMedicine, alice, seen({ personId: alice }));
		h.call(mod.markMedicineNotFound, bob, { id: 1n });
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
		expect(h.rows("medicineSighting")).toHaveLength(3);
		expect(() => h.call(mod.rememberMedicine, bob, seen())).toThrow(
			"a newer sighting is already stored",
		);
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
		h.call(mod.markMedicineNotFound, bob, { id: 1n });
		expect(h.rows("medicineSighting")[0]).toMatchObject({
			place: "kitchen",
			notFoundAt: at("2026-01-05T12:00:30Z"),
		});
		for (const [who, id] of [
			[bob, 9n],
			[mallory, 1n],
		] as const)
			expect(() => h.call(mod.markMedicineNotFound, who, { id })).toThrow(
				"not a member of this family",
			);
	});

	test("any object keeps its category, picture, and earlier places, newest last", () => {
		on();
		const keys = { container: "keys", category: "keys", thumbnail: "/9j/AA" };
		h.call(mod.rememberMedicine, bob, seen(keys));
		for (const [minute, place] of [
			["51", "sofa"],
			["52", "kitchen"],
		] as const)
			h.call(
				mod.rememberMedicine,
				bob,
				seen({ ...keys, place, seenAt: at(`2026-01-05T11:${minute}:00Z`) }),
			);
		expect(h.rows("medicineSighting")).toMatchObject([
			{ ...keys, place: "kitchen", pastPlaces: ["kitchen", "sofa"] },
		]);
		expect(() =>
			h.call(mod.rememberMedicine, bob, seen({ category: " " })),
		).toThrow("category must not be empty");
		expect(() =>
			h.call(
				mod.rememberMedicine,
				bob,
				seen({ thumbnail: "A".repeat(64 * 1024 + 1) }),
			),
		).toThrow("the thumbnail is too large");
	});

	test("an AR pin follows its object's member rule and goes with the member's memory", () => {
		on();
		h.call(mod.rememberMedicine, bob, seen());
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: carol });
		const pin = { familyId: 1n, objectId: 1n, anchorId: "a", mapBytes: 10 };
		expect(() => h.call(mod.saveMedicineArPin, carol, pin)).toThrow(
			"no care access:",
		);
		h.call(mod.saveMedicineArPin, bob, pin);
		// The column keeps its first name, so a pin saved before #301 is the same row.
		expect(h.rows("medicineArPin")).toMatchObject([
			{ containerId: 1n, anchorId: "a", savedBy: bob },
		]);
		expect(h.view(mod.myMedicineArPins, bob)).toHaveLength(1);
		expect(h.view(mod.myMedicineArPins, carol)).toEqual([]);
		expect(h.view(mod.myMedicineArPins, alice)).toHaveLength(1);
		expect(() =>
			h.call(mod.deleteMedicineArPin, carol, { familyId: 1n, objectId: 1n }),
		).toThrow("no care access:");
		expect(() =>
			h.call(mod.saveMedicineArPin, bob, { ...pin, objectId: 9n }),
		).toThrow("no such sighting in this family");

		h.call(mod.setMedicineMemory, bob, {
			familyId: 1n,
			personId: bob,
			enabled: false,
			places: [],
		});
		expect(h.rows("medicineArPin")).toEqual([]);
	});

	test("the migration gives every shared row to the wearer and keeps it", () => {
		const op = identity(9);
		h.call(mod.init, op, {});
		const setAt = at("2026-01-01T08:00:00Z");
		h.db.medicineMemory?.insert({
			familyId: 1n,
			places: ["kitchen", "hall"],
			setBy: bob,
			setAt,
		});
		const legacy = {
			id: 0n,
			familyId: 1n,
			container: "Aspirin",
			place: "kitchen",
			seenAt: setAt,
			source: "camera_check",
			confidence: 0.9,
			labelRead: true,
			savedBy: bob,
			notFoundAt: undefined,
			personId: Identity.zero(),
			// The values SpacetimeDB gives the columns added in #301 to an existing row.
			category: "medicine",
			thumbnail: "",
			pastPlaces: [],
		};
		h.db.medicineSighting?.insert(legacy);
		expect(() => h.call(mod.migrateMedicineMembers, bob, {})).toThrow(
			"not the delivery operator",
		);

		h.call(mod.migrateMedicineMembers, op, {});
		const places = h.rows("medicinePlaces");
		const sightings = h.rows("medicineSighting");
		expect(places).toEqual([
			{
				id: 1n,
				familyId: 1n,
				personId: alice,
				places: ["kitchen", "hall"],
				setBy: bob,
				setAt,
			},
		]);
		expect(sightings).toEqual([{ ...legacy, id: 1n, personId: alice }]);
		expect(h.rows("medicineMemory")).toEqual([]);
		expect(h.view(mod.myMedicineSightings, alice)).toHaveLength(1);

		h.call(mod.migrateMedicineMembers, op, {});
		expect(h.rows("medicinePlaces")).toEqual(places);
		expect(h.rows("medicineSighting")).toEqual(sightings);
	});
});
