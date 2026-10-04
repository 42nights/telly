// Cooking routes (#42), mounted at `/api/families/:familyId`. The cooking profile is care-plan data:
// the module's view returns it only to `health_records` holders and its reducer needs
// `care_plan_edit`, like the #26 care profile it sits beside.
import {
	CookingProfile,
	type CookingProfileRecord,
	CookingRequest,
	type CookingSuggestions,
} from "@health/contracts/cooking";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { suggestMeals } from "../cooking/suggest";
import { callReducer, decodeBody, type FamilyEnv } from "../http";
import { readCareFacts, requireScope } from "./care-profile";

type Ctx = Context<FamilyEnv>;

const ProfileJson = Schema.fromJsonString(CookingProfile);

const readCooking = (c: Ctx): CookingProfileRecord => {
	const latest = [...c.var.db.connection.db.myCookingProfiles.iter()].find(
		(row) => row.familyId === c.var.familyId,
	);
	return {
		profile:
			latest === undefined
				? null
				: Schema.decodeUnknownSync(ProfileJson)(latest.profile),
		editedBy: latest?.editedBy.toHexString() ?? null,
		editedAt: latest?.editedAt.toISOString() ?? null,
	};
};

export const cookingRoutes = () =>
	new Hono<FamilyEnv>()
		.get("/cooking/profile", (c) => {
			requireScope(c, "health_records");
			return c.json(readCooking(c) satisfies CookingProfileRecord);
		})
		.put("/cooking/profile", async (c) => {
			const profile = await decodeBody(c, CookingProfile);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.saveCookingProfile({
					familyId: c.var.familyId,
					profile: Schema.encodeSync(ProfileJson)(profile),
				}),
			);
			return c.body(null, 204);
		})
		.post("/cooking/suggestions", async (c) => {
			const request = await decodeBody(c, CookingRequest);
			const care = readCareFacts(c);
			// Without care access the cooking profile is unreadable too: abilities stay unknown.
			const cooking = care === null ? null : readCooking(c).profile;
			return c.json(
				suggestMeals(request, care, cooking) satisfies CookingSuggestions,
			);
		});
