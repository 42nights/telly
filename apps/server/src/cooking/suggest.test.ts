import { describe, expect, test } from "bun:test";
import type {
	CareInstruction,
	CareProfile,
} from "@health/contracts/care-profile";
import type {
	CookingProfile,
	CookingSuggestions,
} from "@health/contracts/cooking";
import { suggestMeals } from "./suggest";

const unknown: CareProfile = {
	preferredName: null,
	language: null,
	timeZone: null,
	accessibilityNeeds: null,
	diagnoses: null,
	allergies: null,
	dietaryRestrictions: null,
	fluidRestrictions: null,
	activityRestrictions: null,
	routines: null,
	contacts: null,
	familiarDestinations: null,
	devices: null,
	declinedPrompts: [],
};

const instruction = (
	text: string,
	verification: CareInstruction["verification"],
): CareInstruction => ({
	id: "1",
	familyId: "1",
	kind: "care",
	name: "Synthetic plan",
	instruction: text,
	times: [],
	timeZone: null,
	reason: null,
	source: "synthetic discharge sheet",
	effectiveDate: "2026-10-01",
	editedBy: "0".repeat(64),
	editedAt: "2026-10-01T00:00:00.000Z",
	verification,
	verifiedBy: null,
	verifiedAt: null,
});

const abilities = (
	tasks: Partial<CookingProfile["tasks"]>,
): CookingProfile => ({
	tasks: {
		stove: "alone",
		oven: "alone",
		microwave: "alone",
		toaster: "alone",
		knife: "alone",
		...tasks,
	},
	dislikes: [],
});

const none = { available: [], avoid: [] };
const names = (r: CookingSuggestions) => r.suggestions.map((s) => s.id);

describe("suggestMeals", () => {
	test("unknown care facts and abilities are disclosed and every hot or sharp step needs a helper", () => {
		const result = suggestMeals(none, null, null);
		expect(result.notices).toContain(
			"You cannot read the care profile, so your allergies and food restrictions are unknown. Ask your caregiver before you choose.",
		);
		expect(result.notices).toContain(
			"Nobody has recorded which kitchen tasks you do alone, so every hot or sharp step needs a helper.",
		);
		for (const step of result.suggestions.flatMap((s) => s.steps))
			expect(step.helper).toBe(step.task !== null);

		const blank = suggestMeals(
			none,
			{ profile: unknown, instructions: [] },
			null,
		);
		expect(blank.notices).toContain(
			"Your allergies are not recorded. Ask your caregiver before you choose.",
		);
		expect(blank.notices).toContain(
			"Your food restrictions are not recorded. Ask your caregiver before you choose.",
		);
	});

	test("allergies and restrictions remove meals; unrecognised text is disclosed, not ignored", () => {
		const result = suggestMeals(
			none,
			{
				profile: {
					...unknown,
					allergies: ["Eggs", "synthetic-kiwi"],
					dietaryRestrictions: ["vegan"],
				},
				instructions: [],
			},
			abilities({}),
		);
		expect(names(result)).toEqual(["beans-on-toast", "hummus-wrap"]);
		expect(result.notices).toContain(
			"I could not check “synthetic-kiwi” against these meals. Ask your caregiver before you choose.",
		);
		expect(result.notices.some((n) => n.startsWith("Read the labels"))).toBe(
			true,
		);
	});

	test("a pureed diet leaves no meal rather than an unsafe one", () => {
		const result = suggestMeals(
			none,
			{
				profile: { ...unknown, allergies: [], dietaryRestrictions: [] },
				instructions: [instruction("Pureed food only (IDDSI 4)", "verified")],
			},
			abilities({}),
		);
		expect(result.suggestions).toEqual([]);
		expect(result.instructions).toEqual([
			{
				name: "Synthetic plan",
				instruction: "Pureed food only (IDDSI 4)",
				verified: true,
			},
		]);
	});

	test("an unverified food instruction still narrows meals and says it is unverified", () => {
		const result = suggestMeals(
			none,
			{
				profile: { ...unknown, allergies: [], dietaryRestrictions: [] },
				instructions: [
					instruction("No dairy", "conflicting"),
					instruction("Walk twice a day", "verified"),
				],
			},
			abilities({}),
		);
		expect(result.notices).toContain(
			"The care instruction “Synthetic plan” is not verified. Ask your caregiver.",
		);
		expect(names(result)).toEqual(["beans-on-toast", "hummus-wrap"]);
		expect(result.instructions.map((i) => i.instruction)).toEqual(["No dairy"]);
	});

	test("agreed abilities mark helper steps and remove meals that need a forbidden task", () => {
		const result = suggestMeals(
			none,
			{
				profile: { ...unknown, allergies: [], dietaryRestrictions: [] },
				instructions: [],
			},
			abilities({ oven: "not_allowed", stove: "with_helper" }),
		);
		expect(names(result)).not.toContain("cheese-on-toast");
		expect(result.notices).toContain(
			"Some meals are not shown because they use the oven, which you agreed not to use.",
		);
		const eggs = result.suggestions.find((s) => s.id === "scrambled-eggs");
		expect(eggs?.steps.filter((s) => s.helper).map((s) => s.task)).toEqual([
			"stove",
			"stove",
			"stove",
		]);
	});

	test("dislikes and today's choices apply; meals the wearer can make come first", () => {
		const result = suggestMeals(
			{ available: ["Yogurt", "bananas", "potatoes"], avoid: ["cheese"] },
			{
				profile: { ...unknown, allergies: [], dietaryRestrictions: [] },
				instructions: [],
			},
			{ ...abilities({}), dislikes: ["hummus"] },
		);
		expect(names(result)).not.toContain("hummus-wrap");
		expect(names(result)).not.toContain("jacket-potato");
		expect(names(result)[0]).toBe("yogurt-banana");
		expect(
			result.suggestions[0]?.ingredients.filter((i) => i.have).length,
		).toBe(2);
	});
});
