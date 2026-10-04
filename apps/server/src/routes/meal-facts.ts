// Meal photo estimates and separate intake reports, mounted at `/api/families/:familyId`. The
// server records a photo or an estimate only as itself; a meal's intake changes only through
// `POST /meals/:mealId/intake`. The module's reducer checks family membership again.
import {
	type IntakeReport,
	MAX_MEAL_IMAGE_BYTES,
	type Meal,
	type MealEstimate,
	MealEstimateRequest,
	MealFact,
	MealId,
	MealIntakeReport,
	type MealRecord,
	type Meals,
} from "@health/contracts/meal-facts";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import type { GeminiConfig } from "../integrations/gemini";
import { estimateMeal, GEMINI_MEAL_MODEL } from "../integrations/gemini-meal";
import { imageSize } from "./vision";

// Base64 grows 4/3; the rest is the request's other fields.
const MAX_BODY_BYTES = Math.ceil(MAX_MEAL_IMAGE_BYTES / 3) * 4 + 16 * 1024;

const Fact = Schema.fromJsonString(MealFact);

const readMeals = (c: Context<FamilyEnv>): Meal[] => {
	const meals = new Map<string, MealRecord[]>();
	const rows = [...c.var.db.connection.db.myMealFacts.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const row of rows) {
		const facts = meals.get(row.mealId) ?? [];
		facts.push({
			id: row.id.toString(),
			fact: Schema.decodeUnknownSync(Fact)(row.fact),
			recordedBy: row.recordedBy.toHexString(),
			recordedAt: row.recordedAt.toISOString(),
		});
		meals.set(row.mealId, facts);
	}
	return (
		[...meals]
			.map(([mealId, facts]) => {
				// Only an intake report sets intake; photos and estimates never do.
				let latest: IntakeReport | undefined;
				for (const { fact } of facts)
					if (fact.type === "intake_report") latest = fact;
				const intake: Meal["intake"] =
					latest === undefined
						? "not_reported"
						: latest.amount === "unknown" && latest.words === null
							? "unknown"
							: "reported";
				return { mealId, intake, facts };
			})
			// Newest activity first. Database times share one fixed-width UTC format.
			.sort((a, b) =>
				(b.facts.at(-1)?.recordedAt ?? "").localeCompare(
					a.facts.at(-1)?.recordedAt ?? "",
				),
			)
	);
};

const mealIdParam = (c: Context<FamilyEnv>) => {
	const mealId = c.req.param("mealId");
	if (mealId === undefined || !Schema.is(MealId)(mealId))
		throw new ApiFailure("invalid_request", "mealId is not a valid meal id");
	return mealId;
};

const record = (c: Context<FamilyEnv>, mealId: string, fact: MealFact) =>
	callReducer(c.var.db, (connection) =>
		connection.reducers.recordMealFact({
			familyId: c.var.familyId,
			mealId,
			fact: Schema.encodeSync(Fact)(fact),
		}),
	);

/** Rejects a photo that is too large or does not match its declared type. */
const checkPhoto = ({
	type,
	data,
}: {
	type: "image/jpeg" | "image/png";
	data: string;
}) => {
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > MAX_MEAL_IMAGE_BYTES)
		throw new ApiFailure(
			"invalid_request",
			`image is larger than ${MAX_MEAL_IMAGE_BYTES} bytes`,
		);
	const size = imageSize(type, bytes);
	if (size === undefined || size.width === 0 || size.height === 0)
		throw new ApiFailure("invalid_request", `image is not a valid ${type}`);
};

/** Without a Gemini config (no `GEMINI_API_KEY`) estimates are `unavailable`; intake reports still work. */
export const mealRoutes = (gemini: GeminiConfig | undefined) =>
	new Hono<FamilyEnv>()
		.get("/meals", (c) => c.json({ meals: readMeals(c) } satisfies Meals))
		.post(
			"/meals/:mealId/estimates",
			bodyLimit({
				maxSize: MAX_BODY_BYTES,
				onError: () => {
					throw new ApiFailure("invalid_request", "The body is too large");
				},
			}),
			async (c) => {
				const mealId = mealIdParam(c);
				// decodeBody's message never echoes the body, so the photo stays out of the reply.
				const request = await decodeBody(c, MealEstimateRequest);
				// The photo was taken whether or not an estimate follows; the photo itself is not kept.
				if (request.source === "photo") {
					checkPhoto(request.image);
					await record(c, mealId, {
						type: "photo_taken",
						capturedAt: request.capturedAt,
					});
				}
				if (gemini === undefined)
					throw new ApiFailure(
						"unavailable",
						"Meal estimates are not configured",
					);
				const items = await estimateMeal(gemini, request, c.req.raw.signal);
				const estimate: MealEstimate = {
					basis: "estimate",
					source: request.source,
					estimator: GEMINI_MEAL_MODEL,
					estimatedAt: new Date().toISOString(),
					items,
				};
				await record(c, mealId, { type: "food_estimate", estimate });
				return c.json(estimate satisfies MealEstimate);
			},
		)
		.post("/meals/:mealId/intake", async (c) => {
			const mealId = mealIdParam(c);
			await record(c, mealId, await decodeBody(c, MealIntakeReport));
			const meal = readMeals(c).find((m) => m.mealId === mealId);
			if (meal === undefined)
				throw new ApiFailure("internal", "The report was not recorded");
			return c.json(meal satisfies Meal);
		});
