import { beforeEach, describe, expect, test } from "bun:test";
import { harness, identity, mod } from "./test/harness.test";

// Automatic trips (#302): the dwell and distance rules, and who sees a trip start or end.
const alice = identity(1);
const bob = identity(2);
const carol = identity(3);
const mallory = identity(9);
const HOME = { latitude: 40, longitude: -73 };
// One meter north of home, in degrees of latitude (Earth radius 6,371 km).
const METER = 1 / 111_195;

let h = harness();
beforeEach(() => {
	h = harness("2026-01-05T12:00:00Z");
	h.call(mod.createFamily, alice, { name: "Rivera" });
	for (const member of [bob, carol])
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member });
	h.call(mod.shareLocation, alice, { familyId: 1n, viewer: bob });
	h.call(mod.setCareGrant, alice, {
		familyId: 1n,
		member: bob,
		scope: "location",
		granted: true,
	});
	h.call(mod.setHome, alice, {
		familyId: 1n,
		home: HOME,
		radiusMeters: 200,
		autoTrip: true,
	});
});

/** Reports a fix `meters` north of home, `seconds` after the previous call. */
const at = (seconds: number, meters: number, accuracyMeters = 10) => {
	h.advance(seconds);
	h.call(mod.reportLocation, alice, {
		familyId: 1n,
		status: { tag: "Fix" },
		fix: {
			latitude: HOME.latitude + meters * METER,
			longitude: HOME.longitude,
			accuracyMeters,
			fixTime: h.now,
		},
	});
};
const events = (who = alice) =>
	h
		.view<{ kind: { tag: string }; manual: boolean }>(mod.myAwayEvents, who)
		.map((e) => `${e.kind.tag}${e.manual ? " manual" : ""}`);
const watch = () =>
	h.rows<{
		awaySince?: unknown;
		outsideSince?: unknown;
		distanceMeters?: number;
	}>("homeWatch")[0];

describe("automatic trips", () => {
	test("a trip starts after a minute clearly outside the radius, from the first such fix", () => {
		at(0, 300);
		const left = h.now;
		at(30, 400);
		expect(events()).toEqual([]);
		at(30, 500);
		expect(events()).toEqual(["Left"]);
		expect(watch()?.awaySince).toEqual(left);
		at(60, 900);
		expect(events()).toEqual(["Left"]);
		// The person's own status reads the distance of the latest fix from home.
		expect(watch()?.distanceMeters).toBeCloseTo(900, 0);
	});

	test("GPS jitter under 50 m at home never starts a trip", () => {
		for (let i = 0; i < 20; i++) at(30, [10, 45, 49, 0][i % 4] ?? 0, 30);
		// Outside the radius only within the fix's accuracy: not clearly out.
		at(30, 230, 65);
		at(90, 240, 65);
		expect(events()).toEqual([]);
	});

	test("one fix outside, then back inside, is no trip", () => {
		at(0, 300);
		at(30, 20);
		at(60, 300);
		expect(events()).toEqual([]);
	});

	test("the trip ends at the first fix inside the radius", () => {
		at(0, 300);
		at(60, 300);
		// Too vague to say the person is home.
		at(60, 50, 250);
		expect(events()).toEqual(["Left"]);
		at(60, 50, 20);
		expect(events()).toEqual(["Left", "Back"]);
		expect(watch()).toMatchObject({
			awaySince: undefined,
			outsideSince: undefined,
		});
	});

	test("nothing starts with automatic trips off or no home set", () => {
		h.call(mod.setHome, alice, {
			familyId: 1n,
			home: HOME,
			radiusMeters: 200,
			autoTrip: false,
		});
		at(0, 300);
		at(120, 300);
		h.call(mod.setHome, alice, {
			familyId: 1n,
			home: undefined,
			radiusMeters: 200,
			autoTrip: true,
		});
		at(0, 300);
		at(120, 300);
		expect(events()).toEqual([]);
	});

	test("a manual trip waits for a fix outside before a fix at home ends it", () => {
		h.call(mod.setAway, alice, { familyId: 1n, away: true });
		h.call(mod.setAway, alice, { familyId: 1n, away: true });
		at(30, 10);
		expect(events()).toEqual(["Left manual"]);
		at(30, 300);
		at(30, 10);
		expect(events()).toEqual(["Left manual", "Back"]);
		h.call(mod.setAway, alice, { familyId: 1n, away: true });
		h.call(mod.setAway, alice, { familyId: 1n, away: false });
		expect(events()).toEqual([
			"Left manual",
			"Back",
			"Left manual",
			"Back manual",
		]);
	});

	test.each([99, 5001])("setHome refuses a %d m radius", (radiusMeters) => {
		expect(() =>
			h.call(mod.setHome, alice, {
				familyId: 1n,
				home: HOME,
				radiusMeters,
				autoTrip: true,
			}),
		).toThrow("radiusMeters must be 100 to 5000");
	});

	test("only the person reads their home", () => {
		expect(h.view(mod.myHomeWatch, alice)).toHaveLength(1);
		expect(h.view(mod.myHomeWatch, bob)).toEqual([]);
		expect(() =>
			h.call(mod.setHome, mallory, {
				familyId: 1n,
				home: HOME,
				radiusMeters: 200,
				autoTrip: true,
			}),
		).toThrow("not a member of this family");
	});
});

describe("who sees a trip start or end", () => {
	test("only people the person shares with, who hold the location scope", () => {
		at(0, 300);
		at(60, 300);
		expect(events(bob)).toEqual(["Left"]);
		// Carol holds the scope but has no share; Mallory is not in the family.
		h.call(mod.setCareGrant, alice, {
			familyId: 1n,
			member: carol,
			scope: "location",
			granted: true,
		});
		expect(events(carol)).toEqual([]);
		expect(events(mallory)).toEqual([]);
		// A share shows no event from before it began.
		h.advance(1);
		h.call(mod.shareLocation, alice, { familyId: 1n, viewer: carol });
		at(60, 20);
		expect(events(carol)).toEqual(["Back"]);
		h.call(mod.setCareGrant, alice, {
			familyId: 1n,
			member: bob,
			scope: "location",
			granted: false,
		});
		expect(events(bob)).toEqual([]);
	});

	test("the last revoked share deletes the events", () => {
		at(0, 300);
		at(60, 300);
		h.call(mod.revokeLocationShare, alice, { familyId: 1n, viewer: bob });
		expect(h.rows("awayEvent")).toEqual([]);
	});
});
