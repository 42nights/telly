// The fixed list of simple meals that cooking suggestions choose from (#42). Each recipe lists
// every major allergen of its ingredients, so a recognised allergy is checked against all of them;
// packaged foods are marked so the wearer is told to read their labels.
// ponytail: fixed synthetic catalog; family-recorded recipes when a household needs its own meals.
import type { CookingTask } from "@health/contracts/cooking";

export type Allergen =
	| "milk"
	| "egg"
	| "gluten"
	| "peanut"
	| "tree_nut"
	| "sesame"
	| "soy"
	| "fish"
	| "shellfish"
	| "mustard"
	| "celery";

/** `soft`: easy to chew. `pureed`: smooth texture for swallowing difficulty; no recipe here is. */
export type DietTag = "vegetarian" | "vegan" | "soft" | "pureed";

export type Recipe = {
	readonly id: string;
	readonly name: string;
	readonly ingredients: readonly {
		readonly name: string;
		readonly optional?: true;
		readonly packaged?: true;
	}[];
	readonly allergens: readonly Allergen[];
	readonly diet: readonly DietTag[];
	readonly steps: readonly [Step, ...Step[]];
};

type Step = {
	readonly text: string;
	readonly explain: string;
	readonly task?: CookingTask;
};

const stoveOff: Step = {
	text: "Turn the stove off. Check that the knob points to Off.",
	explain:
		"I cannot see the stove. Look at the knob yourself, or ask your helper to check it.",
	task: "stove",
};

export const recipes: readonly Recipe[] = [
	{
		id: "scrambled-eggs",
		name: "Scrambled eggs on toast",
		ingredients: [
			{ name: "egg" },
			{ name: "bread", packaged: true },
			{ name: "butter" },
			{ name: "milk", optional: true },
			{ name: "salt", optional: true },
		],
		allergens: ["egg", "gluten", "milk"],
		diet: ["vegetarian"],
		steps: [
			{
				text: "Crack two eggs into a bowl.",
				explain:
					"Tap each egg on the edge of the bowl, then pull the shell apart with your thumbs. Take out any bits of shell with a spoon.",
			},
			{
				text: "Add a splash of milk and a pinch of salt, then stir with a fork.",
				explain:
					"Milk and salt are optional. Stir until the yellow and the white are mixed.",
			},
			{
				text: "Put a small pan on the stove on a low heat and add a little butter.",
				explain: "A low heat stops the eggs from burning.",
				task: "stove",
			},
			{
				text: "Put two slices of bread in the toaster.",
				explain: "Push the lever down. The toast pops up when it is ready.",
				task: "toaster",
			},
			{
				text: "Pour the eggs into the pan and stir slowly until they are just set.",
				explain:
					"Keep stirring with a spatula. They are ready when no runny liquid is left.",
				task: "stove",
			},
			stoveOff,
			{
				text: "Put the toast on a plate and spoon the eggs on top.",
				explain: "The pan is still hot. Put it on a cold part of the stove.",
			},
		],
	},
	{
		id: "porridge",
		name: "Porridge with banana",
		ingredients: [
			{ name: "oats", packaged: true },
			{ name: "milk" },
			{ name: "banana", optional: true },
		],
		allergens: ["gluten", "milk"],
		diet: ["vegetarian", "soft"],
		steps: [
			{
				text: "Put half a cup of oats in a bowl that can go in the microwave.",
				explain: "A bowl marked “microwave safe” is best. Do not use metal.",
			},
			{
				text: "Pour in one cup of milk and stir.",
				explain: "Use the same cup to measure the milk.",
			},
			{
				text: "Microwave for two minutes, then stir.",
				explain: "Use an oven glove or a cloth. The bowl can be hot.",
				task: "microwave",
			},
			{
				text: "Microwave for one more minute, until it is thick.",
				explain: "If it is still runny, microwave for 30 more seconds.",
				task: "microwave",
			},
			{
				text: "Let it stand for one minute. It is very hot.",
				explain:
					"Porridge keeps cooking for a short time and can burn your mouth.",
			},
			{
				text: "If you have a banana, peel it and slice it on top with a table knife.",
				explain: "A table knife is enough for a banana.",
			},
		],
	},
	{
		id: "cheese-sandwich",
		name: "Cheese and tomato sandwich",
		ingredients: [
			{ name: "bread", packaged: true },
			{ name: "cheese" },
			{ name: "tomato", optional: true },
			{ name: "butter", optional: true },
		],
		allergens: ["gluten", "milk"],
		diet: ["vegetarian"],
		steps: [
			{
				text: "Spread a little butter on two slices of bread.",
				explain: "Butter is optional. Use a table knife.",
			},
			{
				text: "Cut a few thin slices of cheese.",
				explain:
					"Hold the cheese flat on a board and keep your fingers away from the blade. Sliced cheese from a packet also works.",
				task: "knife",
			},
			{
				text: "Cut the tomato into thin slices.",
				explain: "Tomato is optional. A small sharp knife works best.",
				task: "knife",
			},
			{
				text: "Lay the cheese and tomato on one slice and press the other slice on top.",
				explain: "Press gently so the filling stays inside.",
			},
		],
	},
	{
		id: "beans-on-toast",
		name: "Beans on toast",
		ingredients: [
			{ name: "baked beans", packaged: true },
			{ name: "bread", packaged: true },
		],
		allergens: ["gluten"],
		diet: ["vegetarian", "vegan"],
		steps: [
			{
				text: "Open the tin of beans.",
				explain:
					"Pull the ring slowly. If the tin has no ring, ask someone to open it with a tin opener.",
			},
			{
				text: "Pour the beans into a bowl that can go in the microwave, and cover it.",
				explain: "A plate on top works as a cover.",
			},
			{
				text: "Microwave for one minute, stir, then microwave for one more minute.",
				explain: "Use an oven glove. The bowl and the beans can be very hot.",
				task: "microwave",
			},
			{
				text: "Put two slices of bread in the toaster.",
				explain: "Push the lever down. The toast pops up when it is ready.",
				task: "toaster",
			},
			{
				text: "Put the toast on a plate and spoon the beans on top.",
				explain: "Stir the beans first so they are hot all the way through.",
			},
		],
	},
	{
		id: "yogurt-banana",
		name: "Yogurt with banana",
		ingredients: [
			{ name: "yogurt" },
			{ name: "banana" },
			{ name: "honey", optional: true },
		],
		allergens: ["milk"],
		diet: ["vegetarian", "soft"],
		steps: [
			{
				text: "Spoon some yogurt into a bowl.",
				explain: "About four big spoons is one bowl.",
			},
			{
				text: "Peel the banana and slice it with a table knife.",
				explain: "A table knife is enough for a banana.",
			},
			{
				text: "Put the banana on the yogurt. Add a little honey if you like.",
				explain: "Honey is optional.",
			},
		],
	},
	{
		id: "jacket-potato",
		name: "Jacket potato with cheese",
		ingredients: [
			{ name: "potato" },
			{ name: "cheese" },
			{ name: "butter", optional: true },
		],
		allergens: ["milk"],
		diet: ["vegetarian"],
		steps: [
			{
				text: "Wash the potato and prick it all over with a fork.",
				explain: "The holes let steam out so the potato does not burst.",
			},
			{
				text: "Put it on a plate and microwave for five minutes.",
				explain: "Use a plate that can go in the microwave.",
				task: "microwave",
			},
			{
				text: "Turn it over with an oven glove and microwave for three more minutes.",
				explain:
					"It is soft when a fork goes in easily. If not, microwave one more minute at a time.",
				task: "microwave",
			},
			{
				text: "Cut it open with a knife. The steam is very hot.",
				explain: "Hold it with a fork, not your fingers.",
				task: "knife",
			},
			{
				text: "Add a little butter and some cheese.",
				explain: "Butter is optional.",
			},
		],
	},
	{
		id: "hummus-wrap",
		name: "Hummus and vegetable wrap",
		ingredients: [
			{ name: "tortilla wrap", packaged: true },
			{ name: "hummus", packaged: true },
			{ name: "cucumber" },
			{ name: "carrot", optional: true },
		],
		allergens: ["gluten", "sesame"],
		diet: ["vegetarian", "vegan"],
		steps: [
			{
				text: "Lay the wrap flat on a plate.",
				explain: "Keep the plate on the table so it does not slide.",
			},
			{
				text: "Spread two spoons of hummus over the middle.",
				explain: "Leave the edges clear so it rolls up easily.",
			},
			{
				text: "Cut the cucumber, and the carrot if you have one, into thin sticks.",
				explain:
					"Hold them flat on a board and keep your fingers away from the blade.",
				task: "knife",
			},
			{
				text: "Lay the vegetables on the hummus and roll the wrap up tightly.",
				explain: "Fold the bottom up first, then roll from one side.",
			},
		],
	},
	{
		id: "cheese-on-toast",
		name: "Cheese on toast",
		ingredients: [{ name: "bread", packaged: true }, { name: "cheese" }],
		allergens: ["gluten", "milk"],
		diet: ["vegetarian"],
		steps: [
			{
				text: "Turn the oven grill on to medium.",
				explain: "Wait one minute for it to warm up.",
				task: "oven",
			},
			{
				text: "Put two slices of bread on a baking tray and grill one side for two minutes.",
				explain: "Use oven gloves for the tray.",
				task: "oven",
			},
			{
				text: "Take the tray out, turn the bread over, and put cheese on top.",
				explain: "The tray is very hot. Put it on a heat-proof board.",
				task: "oven",
			},
			{
				text: "Grill for two more minutes, until the cheese melts.",
				explain: "Stay near the oven and watch it.",
				task: "oven",
			},
			{
				text: "Take the tray out and turn the grill off. Check that it is off.",
				explain:
					"I cannot see the oven. Look at the knob yourself, or ask your helper to check it.",
				task: "oven",
			},
		],
	},
];
