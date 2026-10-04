// Runs against a real local SpacetimeDB with the module published (`bun run db:test`) and a local
// protocol server in place of the Gemini Interactions API. All records and images are synthetic.
import { afterAll, describe, expect, test } from "bun:test";
import {
	MAX_MEAL_IMAGE_BYTES,
	Meal,
	MealEstimate,
	Meals,
} from "@health/contracts/meal-facts";
import { ReminderHistory } from "@health/contracts/reminders";
import { Effect, Schema } from "effect";
import { Identity } from "spacetimedb";
import type { FamilyDb } from "../db";
import { mealRoutes } from "./meal-facts";
import { reminderRoutes } from "./reminders";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

type Family = { readonly db: FamilyDb; readonly familyId: string };

/** The founder grants itself #26 care scopes (founder bootstrap). */
const grant = (family: Family, scopes: readonly string[]) =>
	Effect.forEach(scopes, (scope) =>
		Effect.promise(() =>
			family.db.connection.reducers.setCareGrant({
				familyId: BigInt(family.familyId),
				member: Identity.fromString(family.db.identity),
				scope,
				granted: true,
			}),
		),
	);

// A PNG header is all the route reads before it forwards the photo; this one says 4×3 pixels.
const photo = {
	type: "image/png",
	data: Buffer.concat([
		Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		Buffer.from([0, 0, 0, 4, 0, 0, 0, 3]),
	]).toString("base64"),
};

let estimates = 0;
const gemini = Bun.serve({
	port: 0,
	fetch: () => {
		estimates++;
		return Response.json({
			status: "completed",
			steps: [
				{
					type: "model_output",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								items: [
									{
										name: "Rice",
										preparation: "boiled",
										portion: "about 1 cup",
										energy_kcal: [260, 180],
										protein_g: [3, 5],
										carbohydrate_g: [40, 55],
										fat_g: [0, 1],
									},
								],
							}),
						},
					],
				},
			],
		});
	},
});
afterAll(() => gemini.stop(true));
const config = { apiKey: "test-key-not-a-secret", baseUrl: gemini.url.href };
// A Gemini that is down: every call fails with HTTP 503.
const down = Bun.serve({
	port: 0,
	fetch: () => new Response("busy", { status: 503 }),
});
afterAll(() => down.stop(true));

describe.skipIf(dbConfig === undefined)("meals", () => {
	test("a photo and its estimate never report intake or complete the meal reminder; only an intake report does", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const family = yield* openFamily(db, "Meal family");
				yield* grant(family, ["health_records", "media"]);
				const app = familyApp(family.db, family.familyId, mealRoutes(config));

				// The meal is a #28 meal reminder's occurrence; its facts link to it by id.
				const reminders = familyApp(
					family.db,
					family.familyId,
					reminderRoutes(),
				);
				yield* send(reminders, "PUT", "/reminder-settings", {
					timeZone: "UTC",
					quietHours: null,
					repeatEveryMinutes: 1,
					maxPrompts: 1,
					snoozeMinutes: 1,
				});
				yield* send(reminders, "POST", "/reminders", {
					kind: "meal",
					subjectId: null,
					title: "Synthetic lunch",
					times: ["12:00"],
				});
				const history = Effect.map(
					send(reminders, "GET", "/reminder-occurrences"),
					(r) => Schema.decodeUnknownSync(ReminderHistory)(r.json).occurrences,
				);
				const occurrenceId = (yield* history)[0]?.occurrence.id;
				if (occurrenceId === undefined) throw new Error("no occurrence");
				const meal = `/meals/${occurrenceId}`;

				const estimated = yield* send(app, "POST", `${meal}/estimates`, {
					source: "photo",
					capturedAt: "2026-10-04T12:00:00.000Z",
					image: photo,
				});
				expect(estimated.status).toBe(200);
				const estimate = Schema.decodeUnknownSync(MealEstimate)(estimated.json);
				expect(estimate.items[0]?.energyKcal).toEqual({ low: 180, high: 260 });

				// The wearer corrects the food; the identity is theirs, the ranges are Gemini's.
				const corrected = yield* send(app, "POST", `${meal}/estimates`, {
					source: "correction",
					items: [
						{ name: "Brown rice", preparation: null, portion: "half a cup" },
					],
				});
				expect(
					Schema.decodeUnknownSync(MealEstimate)(corrected.json).items[0]?.name,
				).toBe("Brown rice");

				const listed = Schema.decodeUnknownSync(Meals)(
					(yield* send(app, "GET", "/meals")).json,
				);
				expect(listed.meals[0]?.intake).toBe("not_reported");
				expect(listed.meals[0]?.facts.map(({ fact }) => fact.type)).toEqual([
					"photo_taken",
					"food_estimate",
					"food_estimate",
				]);

				const help = yield* send(app, "POST", `${meal}/intake`, {
					type: "caregiver_assistance",
					help: "Cut the food",
				});
				expect(Schema.decodeUnknownSync(Meal)(help.json).intake).toBe(
					"not_reported",
				);
				const reported = yield* send(app, "POST", `${meal}/intake`, {
					type: "intake_report",
					kind: "meal",
					amount: "some",
					words: "I ate about half",
					reportedBy: "wearer",
					via: "voice",
				});
				expect(Schema.decodeUnknownSync(Meal)(reported.json).intake).toBe(
					"reported",
				);
				const unknown = yield* send(app, "POST", `${meal}/intake`, {
					type: "intake_report",
					kind: "meal",
					amount: "unknown",
					words: null,
					reportedBy: "caregiver",
					via: "tap",
				});
				expect(Schema.decodeUnknownSync(Meal)(unknown.json).intake).toBe(
					"unknown",
				);

				// No meal fact touched the reminder: completion needs the wearer's answer or a
				// caregiver's confirmation on the reminder itself.
				expect(
					(yield* history).map(({ occurrence, events }) => [
						occurrence.id,
						occurrence.state,
						events.map((e) => e.state),
					]),
				).toEqual([[occurrenceId, "scheduled", ["scheduled"]]]);
			}),
		));

	test("without Gemini the photo is still recorded, and a client cannot post a photo as intake", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const family = yield* openFamily(db, "No camera family");
				yield* grant(family, ["health_records", "media"]);
				const app = familyApp(
					family.db,
					family.familyId,
					mealRoutes(undefined),
				);
				const before = estimates;

				const estimated = yield* send(
					app,
					"POST",
					"/meals/dinner-1/estimates",
					{
						source: "photo",
						capturedAt: "2026-10-04T18:00:00.000Z",
						image: photo,
					},
				);
				expect(failure(estimated)).toEqual([503, "unavailable"]);
				const photoAsIntake = yield* send(
					app,
					"POST",
					"/meals/dinner-1/intake",
					{
						type: "photo_taken",
						capturedAt: "2026-10-04T18:00:00.000Z",
					},
				);
				expect(failure(photoAsIntake)).toEqual([400, "invalid_request"]);

				const meals = Schema.decodeUnknownSync(Meals)(
					(yield* send(app, "GET", "/meals")).json,
				).meals;
				expect(meals.map((m) => [m.intake, m.facts.length])).toEqual([
					["not_reported", 1],
				]);
				expect(estimates).toBe(before);
			}),
		));

	test("meal records need health_records, and a photo also needs media", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const family = yield* openFamily(db, "Sharing family");
				const app = familyApp(family.db, family.familyId, mealRoutes(config));
				expect(failure(yield* send(app, "GET", "/meals"))).toEqual([
					403,
					"forbidden",
				]);

				yield* grant(family, ["health_records"]);
				const before = estimates;
				const photoEstimate = yield* send(
					app,
					"POST",
					"/meals/tea-1/estimates",
					{
						source: "photo",
						capturedAt: "2026-10-04T16:00:00.000Z",
						image: photo,
					},
				);
				expect(failure(photoEstimate)).toEqual([403, "forbidden"]);
				expect(estimates).toBe(before);

				// The module refuses a photo fact without media too, whatever the server does.
				const direct = yield* Effect.promise(() =>
					family.db.connection.reducers
						.recordMealFact({
							familyId: BigInt(family.familyId),
							mealId: "tea-1",
							fact: JSON.stringify({
								type: "photo_taken",
								capturedAt: "2026-10-04T16:00:00.000Z",
							}),
						})
						.then(
							() => "recorded",
							(error: unknown) => String(error),
						),
				);
				expect(direct).toContain("no care access: media");

				const described = yield* send(app, "POST", "/meals/tea-1/estimates", {
					source: "description",
					text: "Tea and toast",
				});
				expect(described.status).toBe(200);
				const meals = Schema.decodeUnknownSync(Meals)(
					(yield* send(app, "GET", "/meals")).json,
				).meals;
				expect(meals[0]?.facts.map(({ fact }) => fact.type)).toEqual([
					"food_estimate",
				]);
			}),
		));

	test("an oversized photo reaches no one, a Gemini failure keeps only the photo, and the newest meal lists first", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const family = yield* openFamily(db, "Busy kitchen family");
				yield* grant(family, ["health_records", "media"]);
				const app = familyApp(family.db, family.familyId, mealRoutes(config));
				const before = estimates;
				const photoOf = (data: string) => ({
					source: "photo",
					capturedAt: "2026-10-04T08:00:00.000Z",
					image: { type: "image/png", data },
				});

				// One byte over the image limit still fits the body limit; the route checks the bytes.
				const large = yield* send(
					app,
					"POST",
					"/meals/big-1/estimates",
					photoOf(Buffer.alloc(MAX_MEAL_IMAGE_BYTES + 1).toString("base64")),
				);
				expect(failure(large)).toEqual([400, "invalid_request"]);
				expect(large.json).toMatchObject({
					message: `image is larger than ${MAX_MEAL_IMAGE_BYTES} bytes`,
				});
				const huge = yield* send(
					app,
					"POST",
					"/meals/big-1/estimates",
					photoOf(
						Buffer.alloc(MAX_MEAL_IMAGE_BYTES + 32 * 1024).toString("base64"),
					),
				);
				expect(failure(huge)).toEqual([400, "invalid_request"]);
				expect(huge.json).toMatchObject({ message: "The body is too large" });
				expect(estimates).toBe(before);
				expect((yield* send(app, "GET", "/meals")).json).toEqual({
					meals: [],
				});

				// Gemini fails after the photo is recorded: the photo stays, no estimate is kept.
				const failing = familyApp(
					family.db,
					family.familyId,
					mealRoutes({ ...config, baseUrl: down.url.href }),
				);
				const upstream = yield* send(
					failing,
					"POST",
					"/meals/breakfast-1/estimates",
					photoOf(photo.data),
				);
				expect(failure(upstream)).toEqual([502, "upstream_error"]);
				expect(upstream.json).toMatchObject({
					message: "The meal estimator failed with HTTP 503",
				});
				yield* send(app, "POST", "/meals/lunch-1/estimates", {
					source: "description",
					text: "Soup and bread",
				});
				const order = Effect.map(send(app, "GET", "/meals"), (r) =>
					Schema.decodeUnknownSync(Meals)(r.json).meals.map((m) => [
						m.mealId,
						m.facts.map(({ fact }) => fact.type),
					]),
				);
				expect(yield* order).toEqual([
					["lunch-1", ["food_estimate"]],
					["breakfast-1", ["photo_taken"]],
				]);

				// A later report moves its meal to the top.
				yield* send(app, "POST", "/meals/breakfast-1/intake", {
					type: "intake_report",
					kind: "meal",
					amount: "all",
					words: null,
					reportedBy: "caregiver",
					via: "tap",
				});
				expect(yield* order).toEqual([
					["breakfast-1", ["photo_taken", "intake_report"]],
					["lunch-1", ["food_estimate"]],
				]);
			}),
		));
});
