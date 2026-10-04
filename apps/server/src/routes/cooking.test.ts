// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import type { CareProfile } from "@health/contracts/care-profile";
import {
	type CookingProfile,
	CookingProfileRecord,
	CookingSuggestions,
} from "@health/contracts/cooking";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { Identity } from "spacetimedb";
import { openFamilyDb } from "../db";
import type { FamilyEnv } from "../http";
import { careProfileRoutes } from "./care-profile";
import { cookingRoutes } from "./cooking";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const care: CareProfile = {
	preferredName: null,
	language: null,
	timeZone: null,
	accessibilityNeeds: null,
	diagnoses: null,
	allergies: ["egg"],
	dietaryRestrictions: [],
	fluidRestrictions: null,
	activityRestrictions: null,
	routines: null,
	contacts: null,
	familiarDestinations: null,
	devices: null,
	declinedPrompts: [],
};

const abilities: CookingProfile = {
	tasks: {
		stove: "with_helper",
		oven: "not_allowed",
		microwave: "alone",
		toaster: "alone",
		knife: "with_helper",
	},
	dislikes: ["synthetic-dislike"],
};

const routes = () =>
	new Hono<FamilyEnv>()
		.route("/", careProfileRoutes())
		.route("/", cookingRoutes());

const suggest = (app: Hono<FamilyEnv>) =>
	send(app, "POST", "/cooking/suggestions", {
		available: ["bread", "baked beans"],
		avoid: [],
	}).pipe(
		Effect.map((r) => Schema.decodeUnknownSync(CookingSuggestions)(r.json)),
	);

describe.skipIf(dbConfig === undefined)("cooking", () => {
	test("suggestions follow care access, the care profile, and agreed abilities", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Cooking");
				const relative = yield* openFamilyDb(config);
				yield* Effect.promise(() =>
					owner.connection.reducers.addFamilyMember({
						familyId: BigInt(familyId),
						member: Identity.fromString(relative.identity),
					}),
				);
				const app = familyApp(owner, familyId, routes());
				const theirs = familyApp(relative, familyId, routes());

				// Without `health_records` nothing is read, and the reply says so.
				expect(failure(yield* send(app, "GET", "/cooking/profile"))).toEqual([
					403,
					"forbidden",
				]);
				const blind = yield* suggest(app);
				expect(blind.notices[0]).toStartWith(
					"You cannot read the care profile",
				);
				expect(blind.suggestions.map((s) => s.id)).toContain("scrambled-eggs");

				for (const scope of [
					"family_access",
					"health_records",
					"care_plan_edit",
				])
					yield* send(app, "POST", "/care-access", {
						identity: owner.identity,
						scope,
						granted: true,
					});
				const empty = Schema.decodeUnknownSync(CookingProfileRecord)(
					(yield* send(app, "GET", "/cooking/profile")).json,
				);
				expect(empty).toEqual({
					profile: null,
					editedBy: null,
					editedAt: null,
				});

				expect((yield* send(app, "PUT", "/care-profile", care)).status).toBe(
					204,
				);
				expect(
					(yield* send(app, "PUT", "/cooking/profile", abilities)).status,
				).toBe(204);
				const saved = Schema.decodeUnknownSync(CookingProfileRecord)(
					(yield* send(app, "GET", "/cooking/profile")).json,
				);
				expect(saved.profile).toEqual(abilities);
				expect(saved.editedBy).toBe(owner.identity);

				// A member without `care_plan_edit` cannot change the agreed abilities.
				expect(
					failure(yield* send(theirs, "PUT", "/cooking/profile", abilities)),
				).toEqual([403, "forbidden"]);

				const result = yield* suggest(app);
				const ids = result.suggestions.map((s) => s.id);
				expect(ids[0]).toBe("beans-on-toast");
				expect(ids).not.toContain("scrambled-eggs");
				expect(ids).not.toContain("cheese-on-toast");
				expect(result.notices).toContain(
					"I could not check “synthetic-dislike” against these meals. Ask your caregiver before you choose.",
				);
				const sandwich = result.suggestions.find(
					(s) => s.id === "cheese-sandwich",
				);
				expect(
					sandwich?.steps.map((s) => [s.task, s.helper]).filter(([t]) => t),
				).toEqual([
					["knife", true],
					["knife", true],
				]);
			}),
		));
});
