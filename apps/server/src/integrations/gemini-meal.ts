// Meal nutrition estimates from Gemini through the Interactions API, with `store: false`: Google
// keeps no copy, and the server never stores the photo. The model output is a fixed JSON schema
// that is checked again here, so no model text other than food names and portions reaches anyone.
import type {
	FoodIdentity,
	MealEstimateRequest,
	MealItem,
} from "@health/contracts/meals";
import { Schema } from "effect";
import { ApiFailure } from "../http";
import type { GeminiConfig } from "./gemini";

/** Pinned so a provider alias change cannot silently change estimates. */
export const GEMINI_MEAL_MODEL = "gemini-3.8-flash";

const requestTimeoutMs = 30_000;

const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Pair = Schema.Tuple([Amount, Amount]);
const Output = Schema.fromJsonString(
	Schema.Struct({
		items: Schema.Array(
			Schema.Struct({
				name: Schema.String,
				preparation: Schema.String,
				portion: Schema.String,
				energy_kcal: Pair,
				protein_g: Pair,
				carbohydrate_g: Pair,
				fat_g: Pair,
			}),
		),
	}),
);

const pair = {
	type: "array",
	items: { type: "number" },
	description: "[low, high] for the served portion; widen it when unsure.",
};
const outputSchema = {
	type: "object",
	properties: {
		items: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					preparation: {
						type: "string",
						description: "How it was prepared; empty if not known.",
					},
					portion: {
						type: "string",
						description:
							"Served portion in plain words, such as 'about 1 cup'.",
					},
					energy_kcal: pair,
					protein_g: pair,
					carbohydrate_g: pair,
					fat_g: pair,
				},
				required: [
					"name",
					"preparation",
					"portion",
					"energy_kcal",
					"protein_g",
					"carbohydrate_g",
					"fat_g",
				],
			},
		},
	},
	required: ["items"],
};

const rules =
	"List each food and drink of the meal with its name, preparation, and served portion. " +
	"Estimate energy (kcal), protein, carbohydrate, and fat (grams) for that served portion as " +
	"[low, high] ranges. These are estimates, not measurements. Do not judge whether or how much " +
	"was eaten, and do not mention weight, diets, or goals. Return an empty list when there is no food.";

const prompt = (request: MealEstimateRequest) => {
	switch (request.source) {
		case "photo":
			return `${rules} The meal is in the photo.`;
		case "description":
			return `${rules} The wearer described the meal: ${JSON.stringify(request.text)}`;
		case "correction":
			return `${rules} The wearer corrected the meal to exactly these items, in this order; keep their names, preparation, and portions: ${JSON.stringify(request.items)}`;
	}
};

const Interaction = Schema.Struct({
	status: Schema.String,
	steps: Schema.Array(
		Schema.Struct({
			type: Schema.String,
			content: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({ text: Schema.optionalKey(Schema.String) }),
				),
			),
		}),
	),
});

const failed = (message: string) => new ApiFailure("upstream_error", message);

const range = ([a, b]: readonly [number, number]) => ({
	low: Math.min(a, b),
	high: Math.max(a, b),
});

/** Gemini's food identity, or "not clear" where it gave none; the estimate stays reviewable. */
const identity = (item: {
	name: string;
	preparation: string;
	portion: string;
}): FoodIdentity => ({
	name: item.name.trim().slice(0, 120).trim() || "Food not clear",
	preparation: item.preparation.trim().slice(0, 120).trim() || null,
	portion: item.portion.trim().slice(0, 120).trim() || "Portion not clear",
});

/**
 * Estimates the served meal. A correction keeps the wearer's food identities exactly and takes only
 * the nutrient ranges from Gemini. Fails with `upstream_error` (never provider text) when Gemini
 * cannot be reached, times out, or replies outside the schema. Aborting `signal` aborts the call.
 */
export const estimateMeal = async (
	config: GeminiConfig,
	request: MealEstimateRequest,
	signal: AbortSignal,
): Promise<MealItem[]> => {
	const input: unknown[] = [{ type: "text", text: prompt(request) }];
	if (request.source === "photo")
		input.push({
			type: "image",
			mime_type: request.image.type,
			data: request.image.data,
		});
	const response = await fetch(
		new URL("/v1beta/interactions", config.baseUrl),
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": config.apiKey,
			},
			body: JSON.stringify({
				model: GEMINI_MEAL_MODEL,
				store: false,
				input,
				response_format: {
					type: "text",
					mime_type: "application/json",
					schema: outputSchema,
				},
				generation_config: { thinking_level: "low", max_output_tokens: 4096 },
			}),
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(config.timeout ?? requestTimeoutMs),
			]),
		},
	).catch((error: unknown) => {
		throw failed(
			error instanceof DOMException && error.name === "TimeoutError"
				? "The meal estimate timed out"
				: "The meal estimator could not be reached",
		);
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw failed(`The meal estimator failed with HTTP ${response.status}`);
	}
	const reply = Schema.decodeUnknownOption(Interaction)(
		await response.json().catch(() => undefined),
	);
	if (reply._tag === "None" || reply.value.status !== "completed")
		throw failed("The meal estimator sent an invalid reply");
	const text = reply.value.steps
		.flatMap((step) =>
			step.type === "model_output"
				? (step.content ?? []).map((part) => part.text ?? "")
				: [],
		)
		.join("");
	const output = Schema.decodeUnknownOption(Output)(text);
	if (output._tag === "None")
		throw failed("The meal estimator sent an invalid reply");
	const { items } = output.value;
	if (request.source === "correction" && items.length !== request.items.length)
		throw failed("The meal estimator changed the corrected food list");
	return items.map((item, index) => ({
		...(request.source === "correction"
			? (request.items[index] ?? identity(item))
			: identity(item)),
		energyKcal: range(item.energy_kcal),
		proteinG: range(item.protein_g),
		carbohydrateG: range(item.carbohydrate_g),
		fatG: range(item.fat_g),
	}));
};
