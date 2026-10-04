// Meal photos, uncertain nutrition estimates, and separate intake reports, under
// `/api/families/:familyId/meals`. Each fact about a meal is its own record. A photo or a food
// estimate never says what was eaten: only an intake report or "unknown" sets a meal's intake.
import { Schema } from "effect";
import { DbId, IdentityHex, UtcTime } from "./families";
import { MAX_VISION_IMAGE_BYTES } from "./vision";

/** Largest decoded meal photo the server accepts. Clients downscale larger frames first. */
export const MAX_MEAL_IMAGE_BYTES = MAX_VISION_IMAGE_BYTES;

const Text = (max: number) =>
	Schema.String.check(
		Schema.isTrimmed(),
		Schema.isNonEmpty(),
		Schema.isMaxLength(max),
	);

/** The client's id for one meal occasion, such as a UUID. It groups the meal's facts. */
export const MealId = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/),
);

const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** An estimated amount: the true value is likely between `low` and `high`. Never a measurement. */
const Range = Schema.Struct({ low: Amount, high: Amount }).check(
	Schema.makeFilter((range: { low: number; high: number }) =>
		range.low <= range.high ? true : "low must not be greater than high",
	),
);

/** What a food is, as the estimator saw it or as the wearer corrected it. */
export const FoodIdentity = Schema.Struct({
	name: Text(120),
	/** How it was prepared ("boiled", "fried"), or `null` when not known. */
	preparation: Schema.NullOr(Text(120)),
	/** The served portion in plain words, such as "about 1 cup". Not the amount eaten. */
	portion: Text(120),
});
export type FoodIdentity = typeof FoodIdentity.Type;

/** One food with estimated energy and macronutrients for its served portion. */
export const MealItem = Schema.Struct({
	...FoodIdentity.fields,
	energyKcal: Range,
	proteinG: Range,
	carbohydrateG: Range,
	fatG: Range,
});
export type MealItem = typeof MealItem.Type;

const EstimateSource = Schema.Literals(["photo", "description", "correction"]);

/**
 * `POST /meals/:mealId/estimates` body: a photo, a spoken or typed description (the fallback when
 * there is no camera or photo), or the wearer's corrected food list. The photo goes to the estimator
 * once and is never stored.
 */
export const MealEstimateRequest = Schema.Union([
	Schema.Struct({
		source: Schema.Literal("photo"),
		/** When the camera took the photo (ISO 8601 UTC). */
		capturedAt: UtcTime,
		image: Schema.Struct({
			type: Schema.Literals(["image/jpeg", "image/png"]),
			/** Base64 bytes; at most `MAX_MEAL_IMAGE_BYTES` once decoded. */
			data: Schema.String.check(
				Schema.isMinLength(1),
				// Effect's `isBase64` regex overflows the V8 stack under Node at a few MiB; this is linear.
				Schema.makeFilter(
					(text: string) =>
						text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text),
				),
			),
		}),
	}),
	Schema.Struct({ source: Schema.Literal("description"), text: Text(2000) }),
	Schema.Struct({
		source: Schema.Literal("correction"),
		items: Schema.Array(FoodIdentity).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(20),
		),
	}),
]);
export type MealEstimateRequest = typeof MealEstimateRequest.Type;

/**
 * An estimate of the served food, with its estimator, source, and time kept, so no report can show
 * it as a measurement. It says nothing about what or how much was eaten.
 */
export const MealEstimate = Schema.Struct({
	basis: Schema.Literal("estimate"),
	source: EstimateSource,
	/** The model that made the estimate. */
	estimator: Schema.String,
	estimatedAt: UtcTime,
	/** Empty when no food was found, for example an empty plate. */
	items: Schema.Array(MealItem),
});
export type MealEstimate = typeof MealEstimate.Type;

/** How much of the served meal was eaten, in the reporter's own judgement. */
export const PortionEaten = Schema.Literals([
	"none",
	"a_little",
	"about_half",
	"most",
	"all",
]);
export type PortionEaten = typeof PortionEaten.Type;

const IntakeReported = Schema.Struct({
	kind: Schema.Literal("intake_reported"),
	/** `null` when the reporter gave only `words`. */
	portion: Schema.NullOr(PortionEaten),
	/** What the reporter said or typed, verbatim. */
	words: Schema.NullOr(Text(2000)),
	reporter: Schema.Literals(["wearer", "caregiver"]),
	via: Schema.Literals(["voice", "text", "tap"]),
}).check(
	Schema.makeFilter((report: { portion: unknown; words: unknown }) =>
		report.portion !== null || report.words !== null
			? true
			: "give a portion, words, or both",
	),
);

const CaregiverAssistance = Schema.Struct({
	kind: Schema.Literal("caregiver_assistance"),
	/** What the caregiver did, such as "cut the food". */
	help: Text(500),
});

const IntakeUnknown = Schema.Struct({ kind: Schema.Literal("intake_unknown") });

/** `POST /meals/:mealId/intake` body: one report, separate from any photo or estimate. */
export const MealIntakeReport = Schema.Union([
	IntakeReported,
	CaregiverAssistance,
	IntakeUnknown,
]);
export type MealIntakeReport = typeof MealIntakeReport.Type;

/** One stored fact. The server records `photo_taken` and `food_estimate`; never the photo. */
export const MealFact = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("photo_taken"), capturedAt: UtcTime }),
	Schema.Struct({
		kind: Schema.Literal("food_estimate"),
		estimate: MealEstimate,
	}),
	IntakeReported,
	CaregiverAssistance,
	IntakeUnknown,
]);
export type MealFact = typeof MealFact.Type;

export const MealRecord = Schema.Struct({
	id: DbId,
	fact: MealFact,
	recordedBy: IdentityHex,
	recordedAt: UtcTime,
});
export type MealRecord = typeof MealRecord.Type;

/**
 * One meal and its facts, oldest first. `intake` comes from the latest intake report or "unknown"
 * only: `not_reported` until someone reports, whatever photos or estimates exist.
 */
export const Meal = Schema.Struct({
	mealId: MealId,
	intake: Schema.Literals(["not_reported", "reported", "unknown"]),
	facts: Schema.Array(MealRecord),
});
export type Meal = typeof Meal.Type;

/** `GET /meals` reply, newest meal first. */
export const Meals = Schema.Struct({ meals: Schema.Array(Meal) });
export type Meals = typeof Meals.Type;
