// Proves the meal path a family member takes: sign in, create a family, get a text estimate and a
// photo estimate, report intake, and see the meal in `GET /meals`; also that an overloaded Gemini
// gives 502 `upstream_error` and records no estimate. Real server and SpacetimeDB; Gemini is fake.
import { describe, expect, test } from "bun:test";
import { CareAccess } from "@health/contracts/care-profile";
import { Meal, MealEstimate, Meals } from "@health/contracts/meal-facts";
import {
	createFamily,
	errorOf,
	integration,
	json,
	startIntegration,
	type User,
} from "./harness";

const it = integration ? await startIntegration() : undefined;

// A valid 1x1 PNG.
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const geminiReply = () =>
	Response.json({
		status: "completed",
		steps: [
			{
				type: "model_output",
				content: [
					{
						text: JSON.stringify({
							items: [
								{
									name: "Oatmeal",
									preparation: "cooked",
									portion: "about 1 cup",
									energy_kcal: [150, 200],
									protein_g: [5, 7],
									carbohydrate_g: [25, 35],
									fat_g: [2, 4],
								},
							],
						}),
					},
				],
			},
		],
	});

/** The founder grants themselves the scopes meals need, as a new family's sharing setup allows. */
const grantMealScopes = async (owner: User, path: string) => {
	for (const scope of ["health_records", "media"])
		expect(
			(
				await owner.call("POST", `${path}/care-access`, {
					identity: owner.identity,
					scope,
					granted: true,
				})
			).status,
		).toBe(204);
	const access = await json(
		CareAccess,
		await owner.call("GET", `${path}/care-access`),
	);
	expect(access.mine).toEqual(
		expect.arrayContaining(["health_records", "media"]),
	);
};

/** Text estimate, photo estimate, intake report, then the meal list. */
const recordMeal = async (owner: User, path: string) => {
	if (it === undefined) throw new Error("integration is off");
	it.providers.gemini = () => geminiReply();
	const before = it.calls.length;
	const mealId = crypto.randomUUID();
	const meal = `${path}/meals/${mealId}`;

	const text = await json(
		MealEstimate,
		await owner.call("POST", `${meal}/estimates`, {
			source: "description",
			text: "A bowl of oatmeal",
		}),
	);
	expect(text.source).toBe("description");
	expect(text.items.map((item) => item.name)).toEqual(["Oatmeal"]);
	expect(text.items[0]?.energyKcal).toEqual({ low: 150, high: 200 });

	const capturedAt = new Date().toISOString();
	const photo = await json(
		MealEstimate,
		await owner.call("POST", `${meal}/estimates`, {
			source: "photo",
			capturedAt,
			image: { type: "image/png", data: PNG },
		}),
	);
	expect(photo.source).toBe("photo");

	const sent = it.calls.slice(before);
	expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /v1beta/interactions",
		"POST /v1beta/interactions",
	]);
	expect(sent[0]?.body).toContain("A bowl of oatmeal");
	expect(sent[1]?.body).toContain(PNG);

	const reported = await json(
		Meal,
		await owner.call("POST", `${meal}/intake`, {
			type: "intake_report",
			kind: "meal",
			amount: "some",
			reportedBy: "wearer",
			words: "I ate half",
			via: "text",
		}),
	);
	expect(reported.intake).toBe("reported");

	const { meals } = await json(Meals, await owner.call("GET", `${path}/meals`));
	const listed = meals.find((m) => m.mealId === mealId);
	expect(listed?.intake).toBe("reported");
	expect(listed?.facts.map((f) => f.fact.type)).toEqual([
		"food_estimate",
		"photo_taken",
		"food_estimate",
		"intake_report",
	]);
};

describe.skipIf(!integration)("meals", () => {
	// #188: a new family has no care grants; flip to test() when #188 merges.
	test.failing("the family creator records a meal", async () => {
		if (it === undefined) return;
		const owner = await it.signIn(`meals-owner-${crypto.randomUUID()}`);
		const { path } = await createFamily(owner);
		await recordMeal(owner, path);
	});

	test("a member with health_records and media records a meal", async () => {
		if (it === undefined) return;
		const owner = await it.signIn(`meals-granted-${crypto.randomUUID()}`);
		const { path } = await createFamily(owner);
		await grantMealScopes(owner, path);
		await recordMeal(owner, path);
	});

	test("an overloaded Gemini gives upstream_error and records no estimate", async () => {
		if (it === undefined) return;
		const owner = await it.signIn(`meals-overload-${crypto.randomUUID()}`);
		const { path } = await createFamily(owner);
		await grantMealScopes(owner, path);
		it.providers.gemini = () => new Response("overloaded", { status: 503 });
		const before = it.calls.length;
		const mealId = crypto.randomUUID();
		const failed = await owner.call(
			"POST",
			`${path}/meals/${mealId}/estimates`,
			{ source: "description", text: "Toast" },
		);
		expect(await errorOf(failed)).toEqual([502, "upstream_error"]);
		expect(it.calls.slice(before).map((call) => call.path)).toEqual([
			"/v1beta/interactions",
		]);
		const { meals } = await json(
			Meals,
			await owner.call("GET", `${path}/meals`),
		);
		expect(meals.find((m) => m.mealId === mealId)).toBeUndefined();
	});
});
