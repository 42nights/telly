import { describe, expect, test } from "bun:test";
import type { CareProfile } from "@health/contracts/care-profile";

import { fromForm, toForm } from "./logic";

const profile: CareProfile = {
	preferredName: "Synthetic Sam",
	language: null,
	timeZone: "Europe/London",
	accessibilityNeeds: null,
	diagnoses: null,
	allergies: [],
	dietaryRestrictions: ["low salt"],
	fluidRestrictions: null,
	activityRestrictions: null,
	routines: [
		{ name: "walk", time: "10:00" },
		{ name: "tea", time: null },
	],
	contacts: [
		{ name: "Synthetic Ana", relationship: "daughter", phone: "555-0100" },
		{ name: "Synthetic Ben", relationship: null, phone: "555-0101" },
		{ name: "Synthetic Cy", relationship: null, phone: null },
	],
	familiarDestinations: [{ name: "Synthetic Park", address: null }],
	devices: null,
	declinedPrompts: ["meals"],
};

describe("care profile form", () => {
	test("keeps unknown, confirmed none, and contact order through a round trip", () => {
		const form = toForm(profile);
		expect(form.allergies).toBe("none");
		expect(form.diagnoses).toBe("");
		expect(fromForm(form)).toEqual(profile);
	});

	test("refuses a box that does not match its format", () => {
		const form = toForm(profile);
		expect(fromForm({ ...form, routines: "walk; 25:00" })).toBeNull();
		expect(fromForm({ ...form, timeZone: "Not/AZone" })).toBeNull();
	});
});
