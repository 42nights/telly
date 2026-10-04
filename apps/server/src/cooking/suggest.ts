// Chooses meals for the wearer (#42). Every allergy, food restriction, food-related care
// instruction, dislike, and choice for today becomes a rule; text that no rule recognises is
// disclosed as unchecked instead of passing silently. Unknown kitchen abilities mean a helper.
import type {
	CareInstruction,
	CareProfile,
} from "@health/contracts/care-profile";
import type {
	CookingProfile,
	CookingRequest,
	CookingSuggestions,
	CookingTask,
	MealSuggestion,
} from "@health/contracts/cooking";
import { type Allergen, type DietTag, type Recipe, recipes } from "./recipes";

type Rule =
	| { readonly kind: "require"; readonly tag: DietTag }
	| { readonly kind: "allergen"; readonly allergen: Allergen }
	| { readonly kind: "ingredient"; readonly name: string };

const singular = (word: string) =>
	word.endsWith("oes")
		? word.slice(0, -2)
		: word.endsWith("ies")
			? `${word.slice(0, -3)}y`
			: word.endsWith("s") && !word.endsWith("ss")
				? word.slice(0, -1)
				: word;

/** Lower-case singular words padded with spaces, so `includes` matches whole words only. */
const words = (text: string) =>
	` ${text
		.toLowerCase()
		.replace(/[^a-z]+/g, " ")
		.trim()
		.split(" ")
		.map(singular)
		.join(" ")} `;

const mentions = (text: string, term: string) =>
	words(text).includes(words(term));

const allergenWords: Record<Allergen, readonly string[]> = {
	milk: ["milk", "dairy", "lactose"],
	egg: ["egg"],
	gluten: ["gluten", "wheat", "coeliac", "celiac"],
	peanut: ["peanut", "groundnut", "nut"],
	tree_nut: ["tree nut", "nut", "almond", "walnut", "cashew", "hazelnut"],
	sesame: ["sesame", "tahini"],
	soy: ["soy", "soya"],
	fish: ["fish"],
	shellfish: ["shellfish", "prawn", "shrimp", "crab", "lobster"],
	mustard: ["mustard"],
	celery: ["celery"],
};

const dietWords: Record<DietTag, readonly string[]> = {
	vegetarian: ["vegetarian"],
	vegan: ["vegan"],
	soft: ["soft", "chew", "chewing", "minced", "mashed"],
	pureed: [
		"puree",
		"pureed",
		"dysphagia",
		"swallow",
		"swallowing",
		"thickened",
		"iddsi",
	],
};

const ingredientNames = [
	...new Set(recipes.flatMap((r) => r.ingredients.map((i) => i.name))),
];

const rulesFor = (text: string): Rule[] => [
	...Object.entries(dietWords)
		.filter(([, terms]) => terms.some((term) => mentions(text, term)))
		.map(([tag]) => ({ kind: "require" as const, tag: tag as DietTag })),
	...Object.entries(allergenWords)
		.filter(([, terms]) => terms.some((term) => mentions(text, term)))
		.map(([allergen]) => ({
			kind: "allergen" as const,
			allergen: allergen as Allergen,
		})),
	...ingredientNames
		.filter((name) => mentions(text, name))
		.map((name) => ({ kind: "ingredient" as const, name })),
];

/** Words that make a care instruction about food even when no rule recognises it. */
const foodWord =
	/ (diet|food|meal|eat|eating|drink|fluid|salt|sodium|sugar|carb|carbohydrate|texture|calorie|protein|fat|fibre|fiber|nutrition) /;

const allows = (recipe: Recipe, rule: Rule) =>
	rule.kind === "require"
		? recipe.diet.includes(rule.tag)
		: rule.kind === "allergen"
			? !recipe.allergens.includes(rule.allergen)
			: !recipe.ingredients.some((i) => mentions(i.name, rule.name));

const taskNames: Record<CookingTask, string> = {
	stove: "the stove",
	oven: "the oven",
	microwave: "the microwave",
	toaster: "the toaster",
	knife: "a sharp knife",
};

/** What the server can read for the caller; `null` without `health_records` access. */
export type CareFacts = {
	readonly profile: CareProfile;
	readonly instructions: readonly CareInstruction[];
};

const ask = "Ask your caregiver before you choose.";

/** Every restriction as rules, and a notice for each unknown or unrecognised one. */
const restrictions = (
	request: CookingRequest,
	care: CareFacts | null,
	cooking: CookingProfile | null,
) => {
	const notices: string[] = [];
	const rules: Rule[] = [];
	const check = (texts: readonly string[]) => {
		for (const text of texts) {
			const found = rulesFor(text);
			if (found.length === 0)
				notices.push(`I could not check “${text}” against these meals. ${ask}`);
			rules.push(...found);
		}
	};
	const food = (care?.instructions ?? []).filter(
		(i) =>
			i.kind === "care" &&
			i.verification !== "stale" &&
			(rulesFor(`${i.name} ${i.instruction}`).length > 0 ||
				foodWord.test(words(`${i.name} ${i.instruction}`))),
	);
	if (care === null)
		notices.push(
			`You cannot read the care profile, so your allergies and food restrictions are unknown. ${ask}`,
		);
	for (const [texts, what] of [
		[care?.profile.allergies, "allergies"],
		[care?.profile.dietaryRestrictions, "food restrictions"],
	] as const) {
		if (texts === null) notices.push(`Your ${what} are not recorded. ${ask}`);
		else if (texts !== undefined) check(texts);
	}
	for (const i of food) {
		// Unverified instructions still narrow the meals; only verified ones are read as instructions.
		if (i.verification !== "verified")
			notices.push(
				`The care instruction “${i.name}” is not verified. Ask your caregiver.`,
			);
		check([`${i.name}: ${i.instruction}`]);
	}
	check(cooking?.dislikes ?? []);
	check(request.avoid);
	if (cooking === null)
		notices.push(
			"Nobody has recorded which kitchen tasks you do alone, so every hot or sharp step needs a helper.",
		);
	return { notices, rules, food };
};

export const suggestMeals = (
	request: CookingRequest,
	care: CareFacts | null,
	cooking: CookingProfile | null,
): CookingSuggestions => {
	const { notices, rules, food } = restrictions(request, care, cooking);
	const support = (task: CookingTask) => cooking?.tasks[task] ?? "with_helper";
	const blocked = new Set<CookingTask>();
	const have = (name: string) =>
		request.available.some((a) => mentions(a, name) || mentions(name, a));

	const suggestions = recipes
		.filter((recipe) => rules.every((rule) => allows(recipe, rule)))
		.filter((recipe) => {
			const refused = recipe.steps.flatMap((s) =>
				s.task !== undefined && support(s.task) === "not_allowed"
					? [s.task]
					: [],
			);
			for (const task of refused) blocked.add(task);
			return refused.length === 0;
		})
		.map(
			(recipe): MealSuggestion => ({
				id: recipe.id,
				name: recipe.name,
				ingredients: recipe.ingredients.map((i) => ({
					name: i.name,
					optional: i.optional === true,
					have: have(i.name),
					packaged: i.packaged === true,
				})),
				steps: recipe.steps.map((s) => ({
					text: s.text,
					explain: s.explain,
					task: s.task ?? null,
					helper: s.task !== undefined && support(s.task) === "with_helper",
				})) as [MealSuggestion["steps"][0], ...MealSuggestion["steps"]],
			}),
		)
		.map((meal) => ({
			meal,
			missing: meal.ingredients.filter((i) => !i.optional && !i.have).length,
			helpers: meal.steps.filter((s) => s.helper).length,
		}))
		.sort((a, b) => a.missing - b.missing || a.helpers - b.helpers)
		.map(({ meal }) => meal);

	if (blocked.size > 0)
		notices.push(
			`Some meals are not shown because they use ${[...blocked].map((t) => taskNames[t]).join(" or ")}, which you agreed not to use.`,
		);
	const packaged = [
		...new Set(
			suggestions.flatMap((s) =>
				s.ingredients.filter((i) => i.packaged).map((i) => i.name),
			),
		),
	];
	if (packaged.length > 0)
		notices.push(
			`Read the labels on packaged foods (${packaged.join(", ")}) for allergens.`,
		);

	return {
		suggestions,
		notices,
		instructions: food.map((i) => ({
			name: i.name,
			instruction: i.instruction,
			verified: i.verification === "verified",
		})),
	};
};
