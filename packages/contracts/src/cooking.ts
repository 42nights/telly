// Cooking suggestions and one-step-at-a-time preparation (#42), under
// `/api/families/:familyId/cooking`. Meals are filtered by the #26 care profile, food-related care
// instructions, and the wearer's agreed kitchen abilities. Nothing here reads a camera: the app
// never decides that a stove or food is safe, or that a meal was eaten.
import { Schema } from "effect";
import { IdentityHex, UtcTime } from "./families";

const Text = (max: number) =>
	Schema.String.check(
		Schema.isTrimmed(),
		Schema.isNonEmpty(),
		Schema.isMaxLength(max),
	);

/** A kitchen task that a recipe step asks of the wearer. `knife` means a sharp knife. */
export const CookingTask = Schema.Literals([
	"stove",
	"oven",
	"microwave",
	"toaster",
	"knife",
]);
export type CookingTask = typeof CookingTask.Type;

/** What the family agreed for one task: alone, only with a helper there, or never. */
export const TaskSupport = Schema.Literals([
	"alone",
	"with_helper",
	"not_allowed",
]);
export type TaskSupport = typeof TaskSupport.Type;

/** `PUT /cooking/profile` body: the agreed support for every task, and foods the wearer dislikes. */
export const CookingProfile = Schema.Struct({
	tasks: Schema.Struct({
		stove: TaskSupport,
		oven: TaskSupport,
		microwave: TaskSupport,
		toaster: TaskSupport,
		knife: TaskSupport,
	}),
	dislikes: Schema.Array(Text(80)).check(Schema.isMaxLength(30)),
});
export type CookingProfile = typeof CookingProfile.Type;

/** `GET /cooking/profile`. `profile` is `null` until someone saves one. */
export const CookingProfileRecord = Schema.Struct({
	profile: Schema.NullOr(CookingProfile),
	editedBy: Schema.NullOr(IdentityHex),
	editedAt: Schema.NullOr(UtcTime),
});
export type CookingProfileRecord = typeof CookingProfileRecord.Type;

/** `POST /cooking/suggestions` body: what the wearer has, and what they do not want today. */
export const CookingRequest = Schema.Struct({
	available: Schema.Array(Text(80)).check(Schema.isMaxLength(40)),
	avoid: Schema.Array(Text(80)).check(Schema.isMaxLength(20)),
});
export type CookingRequest = typeof CookingRequest.Type;

export const RecipeStep = Schema.Struct({
	text: Schema.String,
	/** A longer explanation for "Explain". */
	explain: Schema.String,
	task: Schema.NullOr(CookingTask),
	/** The agreed support for `task` says a helper must be there for this step. */
	helper: Schema.Boolean,
});
export type RecipeStep = typeof RecipeStep.Type;

export const MealSuggestion = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	ingredients: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			optional: Schema.Boolean,
			/** The wearer said they have it. */
			have: Schema.Boolean,
			/** A packaged food whose label the wearer should check for allergens. */
			packaged: Schema.Boolean,
		}),
	),
	steps: Schema.NonEmptyArray(RecipeStep),
});
export type MealSuggestion = typeof MealSuggestion.Type;

/** A food-related care instruction from #26, verbatim, with its verification state. */
export const FoodInstruction = Schema.Struct({
	name: Schema.String,
	instruction: Schema.String,
	verified: Schema.Boolean,
});
export type FoodInstruction = typeof FoodInstruction.Type;

/**
 * `POST /cooking/suggestions` reply, fewest missing ingredients first. `notices` discloses every
 * unknown or unchecked restriction, so an empty list never hides missing information.
 */
export const CookingSuggestions = Schema.Struct({
	suggestions: Schema.Array(MealSuggestion),
	notices: Schema.Array(Schema.String),
	instructions: Schema.Array(FoodInstruction),
});
export type CookingSuggestions = typeof CookingSuggestions.Type;
