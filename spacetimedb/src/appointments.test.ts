import { describe, expect, test } from "bun:test";
import { harness, identity, mod } from "./test/harness.test";

const alice = identity(1);
const bob = identity(2);
const mallory = identity(3);
const DAY = 86_400;

const withAppointment = () => {
	const h = harness("2026-01-05T12:00:00Z");
	h.call(mod.createFamily, alice, { name: "Rivera" });
	h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
	h.call(mod.createFamily, mallory, { name: "Other" });
	h.call(mod.suggestAppointment, alice, {
		id: "a1",
		familyId: 1n,
		visit: "GP check-up",
		prep: "list meds",
		source: "model",
	});
	// The founder may grant scopes until anyone holds family_access.
	const grant = (member: typeof alice, scope: string) =>
		h.call(mod.setCareGrant, alice, {
			familyId: 1n,
			member,
			scope,
			granted: true,
		});
	return Object.assign(h, { grant });
};

// Brings a1 to a reviewed summary and gives alice clinician_delivery.
const shareable = () => {
	const h = withAppointment();
	h.call(mod.reviewAppointmentSummary, alice, { id: "a1", summary: "BP ok" });
	h.grant(alice, "clinician_delivery");
	return h;
};

const share = (consent: string, frequency: string, id = "s1") => ({
	id,
	appointmentId: "a1",
	recipient: "dr@example.org",
	sections: "meds",
	consent,
	frequency,
});

describe("suggestAppointment", () => {
	test("stores a suggestion visible only to members", () => {
		const h = withAppointment();
		expect(h.rows("appointment")[0]).toMatchObject({
			familyId: 1n,
			source: "model",
			suggestedBy: alice,
			requestedAt: undefined,
		});
		expect(h.view(mod.myAppointments, bob)).toHaveLength(1);
		expect(h.view(mod.myAppointments, mallory)).toEqual([]);
	});

	test.each([
		[{ id: " " }, "id must not be empty"],
		[{ visit: "" }, "visit must not be empty"],
		[{ prep: "" }, "prep must not be empty"],
		[{ source: "robot" }, "source must be model or member"],
		[{ id: "a1" }, "appointment id already exists"],
	])("rejects %o", (patch, message) => {
		const h = withAppointment();
		expect(() =>
			h.call(mod.suggestAppointment, alice, {
				id: "a2",
				familyId: 1n,
				visit: "v",
				prep: "p",
				source: "member",
				...patch,
			}),
		).toThrow(message);
		expect(h.rows("appointment")).toHaveLength(1);
	});

	test("an outsider cannot suggest", () => {
		const h = withAppointment();
		expect(() =>
			h.call(mod.suggestAppointment, mallory, {
				id: "a2",
				familyId: 1n,
				visit: "v",
				prep: "p",
				source: "member",
			}),
		).toThrow("not a member of this family");
	});
});

describe("appointment lifecycle", () => {
	test("request then confirm records each step", () => {
		const h = withAppointment();
		h.call(mod.updateAppointmentPrep, bob, { id: "a1", prep: "bring card" });
		h.call(mod.requestAppointment, bob, { id: "a1" });
		h.advance(60);
		h.call(mod.confirmAppointment, alice, { id: "a1", confirmation: "10am" });
		expect(h.rows("appointment")[0]).toMatchObject({
			prep: "bring card",
			requestedBy: bob,
			confirmation: "10am",
			confirmedBy: alice,
		});
	});

	test("a suggestion cannot be confirmed before a request", () => {
		const h = withAppointment();
		expect(() =>
			h.call(mod.confirmAppointment, alice, { id: "a1", confirmation: "x" }),
		).toThrow("only a requested appointment can be confirmed");
	});

	test("request and confirm happen once; blank texts are rejected", () => {
		const h = withAppointment();
		expect(() =>
			h.call(mod.updateAppointmentPrep, alice, { id: "a1", prep: " " }),
		).toThrow("prep must not be empty");
		h.call(mod.requestAppointment, alice, { id: "a1" });
		expect(() => h.call(mod.requestAppointment, alice, { id: "a1" })).toThrow(
			"appointment is already requested",
		);
		expect(() =>
			h.call(mod.confirmAppointment, alice, { id: "a1", confirmation: "" }),
		).toThrow("confirmation must not be empty");
		h.call(mod.confirmAppointment, alice, { id: "a1", confirmation: "ok" });
		expect(() =>
			h.call(mod.confirmAppointment, alice, { id: "a1", confirmation: "ok" }),
		).toThrow("appointment is already confirmed");
		expect(() =>
			h.call(mod.reviewAppointmentSummary, alice, { id: "a1", summary: "" }),
		).toThrow("summary must not be empty");
	});

	test("a cancelled appointment takes no further step", () => {
		const h = withAppointment();
		h.call(mod.cancelAppointment, bob, { id: "a1" });
		expect(h.rows("appointment")[0]?.cancelledBy).toEqual(bob);
		for (const [reducer, args] of [
			[mod.cancelAppointment, { id: "a1" }],
			[mod.requestAppointment, { id: "a1" }],
			[mod.updateAppointmentPrep, { id: "a1", prep: "p" }],
			[mod.reviewAppointmentSummary, { id: "a1", summary: "s" }],
		] as const)
			expect(() => h.call(reducer as never, alice, args as never)).toThrow(
				"appointment is cancelled",
			);
	});

	test("outsiders and unknown ids fail alike", () => {
		const h = withAppointment();
		expect(() => h.call(mod.requestAppointment, mallory, { id: "a1" })).toThrow(
			"not a member of this family",
		);
		expect(() => h.call(mod.requestAppointment, alice, { id: "nope" })).toThrow(
			"not a member of this family",
		);
	});
});

describe("approveClinicianShare", () => {
	test("needs the clinician_delivery scope", () => {
		const h = withAppointment();
		h.call(mod.reviewAppointmentSummary, alice, { id: "a1", summary: "s" });
		expect(() =>
			h.call(mod.approveClinicianShare, alice, share("explicit", "once")),
		).toThrow("no care access: clinician_delivery");
	});

	test("needs a reviewed summary", () => {
		const h = withAppointment();
		h.grant(alice, "clinician_delivery");
		expect(() =>
			h.call(mod.approveClinicianShare, alice, share("explicit", "once")),
		).toThrow("review the summary before sharing it");
	});

	test.each([
		["explicit", "weekly"],
		["standing", "once"],
		["unknown", "once"],
	])("rejects consent %s with frequency %s", (consent, frequency) => {
		const h = shareable();
		expect(() =>
			h.call(mod.approveClinicianShare, alice, share(consent, frequency)),
		).toThrow("consent and frequency do not match");
	});

	test.each([
		[{ id: "" }, "id must not be empty"],
		[{ recipient: " " }, "recipient must not be empty"],
		[{ sections: "" }, "sections must not be empty"],
	])("rejects %o", (patch, message) => {
		const h = shareable();
		expect(() =>
			h.call(mod.approveClinicianShare, alice, {
				...share("explicit", "once"),
				...patch,
			}),
		).toThrow(message);
	});

	test("stores the approved summary time only for explicit consent; ids are unique", () => {
		const h = shareable();
		const reviewed = h.rows("appointment")[0]?.summaryReviewedAt;
		h.call(mod.approveClinicianShare, alice, share("explicit", "once"));
		h.call(mod.approveClinicianShare, alice, share("standing", "weekly", "s2"));
		expect(() =>
			h.call(mod.approveClinicianShare, alice, share("explicit", "once")),
		).toThrow("share id already exists");
		const rows = h.rows("clinicianShare");
		expect(rows.find((s) => s.id === "s1")).toMatchObject({
			familyId: 1n,
			approvedSummaryAt: reviewed,
			sends: 0,
		});
		expect(rows.find((s) => s.id === "s2")?.approvedSummaryAt).toBeUndefined();
		expect(h.view(mod.myClinicianShares, bob)).toHaveLength(2);
		expect(h.view(mod.myClinicianShares, mallory)).toEqual([]);
	});
});

describe("sendClinicianShare", () => {
	test("explicit consent covers exactly one send", () => {
		const h = shareable();
		h.call(mod.approveClinicianShare, alice, share("explicit", "once"));
		h.call(mod.sendClinicianShare, alice, { id: "s1" });
		expect(h.rows("clinicianShare")[0]?.sends).toBe(1);
		expect(() => h.call(mod.sendClinicianShare, alice, { id: "s1" })).toThrow(
			"explicit consent covers one send",
		);
	});

	test("explicit consent lapses when the summary changes", () => {
		const h = shareable();
		h.call(mod.approveClinicianShare, alice, share("explicit", "once"));
		h.advance(1);
		h.call(mod.reviewAppointmentSummary, bob, { id: "a1", summary: "new" });
		expect(() => h.call(mod.sendClinicianShare, alice, { id: "s1" })).toThrow(
			"the summary changed after approval",
		);
		expect(h.rows("clinicianShare")[0]?.sends).toBe(0);
	});

	test.each([
		["weekly", 7],
		["monthly", 30],
	])("standing %s waits the full interval", (frequency, days) => {
		const h = shareable();
		h.call(mod.approveClinicianShare, alice, share("standing", frequency));
		h.call(mod.sendClinicianShare, alice, { id: "s1" });
		h.advance(days * DAY - 1);
		expect(() => h.call(mod.sendClinicianShare, alice, { id: "s1" })).toThrow(
			"not due yet at the agreed frequency",
		);
		h.advance(1);
		h.call(mod.sendClinicianShare, alice, { id: "s1" });
		expect(h.rows("clinicianShare")[0]?.sends).toBe(2);
	});

	test("a member without clinician_delivery cannot send", () => {
		const h = shareable();
		h.call(mod.approveClinicianShare, alice, share("standing", "weekly"));
		expect(() => h.call(mod.sendClinicianShare, bob, { id: "s1" })).toThrow(
			"no care access: clinician_delivery",
		);
	});

	test("a cancelled appointment stops sends", () => {
		const h = shareable();
		h.call(mod.approveClinicianShare, alice, share("standing", "weekly"));
		h.call(mod.cancelAppointment, alice, { id: "a1" });
		expect(() => h.call(mod.sendClinicianShare, alice, { id: "s1" })).toThrow(
			"appointment is cancelled",
		);
	});
});

describe("revokeClinicianShare", () => {
	test("any member revokes; a revoked share neither sends nor revokes again", () => {
		const h = shareable();
		h.call(mod.approveClinicianShare, alice, share("standing", "weekly"));
		h.call(mod.revokeClinicianShare, bob, { id: "s1" });
		expect(h.rows("clinicianShare")[0]?.revokedBy).toEqual(bob);
		expect(() => h.call(mod.sendClinicianShare, alice, { id: "s1" })).toThrow(
			"share is revoked",
		);
		expect(() => h.call(mod.revokeClinicianShare, alice, { id: "s1" })).toThrow(
			"share is revoked",
		);
	});

	test("outsiders and unknown ids fail alike", () => {
		const h = shareable();
		h.call(mod.approveClinicianShare, alice, share("standing", "weekly"));
		expect(() =>
			h.call(mod.revokeClinicianShare, mallory, { id: "s1" }),
		).toThrow("not a member of this family");
		expect(() => h.call(mod.revokeClinicianShare, alice, { id: "x" })).toThrow(
			"not a member of this family",
		);
	});
});

describe("saveCookingProfile", () => {
	test("needs care_plan_edit and non-empty text", () => {
		const h = withAppointment();
		expect(() =>
			h.call(mod.saveCookingProfile, alice, { familyId: 1n, profile: "soft" }),
		).toThrow("no care access: care_plan_edit");
		h.grant(alice, "care_plan_edit");
		expect(() =>
			h.call(mod.saveCookingProfile, alice, { familyId: 1n, profile: " " }),
		).toThrow("profile must not be empty");
		expect(h.rows("cookingProfile")).toEqual([]);
	});

	test("inserts then updates one row, readable with health_records only", () => {
		const h = withAppointment();
		h.grant(alice, "care_plan_edit");
		h.call(mod.saveCookingProfile, alice, { familyId: 1n, profile: "soft" });
		h.call(mod.saveCookingProfile, alice, {
			familyId: 1n,
			profile: "low salt",
		});
		expect(h.rows("cookingProfile")).toMatchObject([
			{ familyId: 1n, profile: "low salt", editedBy: alice },
		]);
		expect(h.view(mod.myCookingProfiles, bob)).toEqual([]);
		h.grant(bob, "health_records");
		expect(h.view(mod.myCookingProfiles, bob)).toMatchObject([
			{ profile: "low salt" },
		]);
	});
});
