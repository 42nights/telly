// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import {
	CareInstructions,
	type CareProfile,
	CareProfileRecord,
	CarePrompt,
} from "@health/contracts/care-profile";
import { Effect, Schema } from "effect";
import type { Hono } from "hono";
import { Identity } from "spacetimedb";
import { openFamilyDb } from "../db";
import type { FamilyEnv } from "../http";
import { careProfileRoutes } from "./care-profile";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const profile: CareProfile = {
	preferredName: "Synthetic Sam",
	language: "en",
	timeZone: "Europe/London",
	accessibilityNeeds: ["large text"],
	diagnoses: null,
	allergies: ["synthetic-penicillin"],
	dietaryRestrictions: [],
	fluidRestrictions: null,
	activityRestrictions: null,
	routines: [{ name: "walk", time: "10:00" }],
	contacts: [
		{ name: "Synthetic Ana", relationship: "daughter", phone: null },
		{ name: "Synthetic Ben", relationship: null, phone: null },
	],
	familiarDestinations: [{ name: "Synthetic Park", address: null }],
	devices: null,
	declinedPrompts: ["meals"],
};

const dose = (instruction: string) => ({
	kind: "medication",
	name: "Synthetic A",
	instruction,
	times: ["08:00"],
	reason: null,
	source: "pharmacy label",
	effectiveDate: "2026-10-01",
});

/** Views of other identities update asynchronously; poll the request until it answers `status`. */
const until = (app: Hono<FamilyEnv>, path: string, status: number) =>
	Effect.gen(function* () {
		for (let tries = 0; ; tries++) {
			const response = yield* send(app, "GET", path);
			if (response.status === status || tries === 100) return response;
			yield* Effect.sleep("20 millis");
		}
	});

const instructions = (app: Hono<FamilyEnv>) =>
	send(app, "GET", "/care-instructions").pipe(
		Effect.map(
			(r) => Schema.decodeUnknownSync(CareInstructions)(r.json).instructions,
		),
	);

describe.skipIf(dbConfig === undefined)("care profile", () => {
	test("grants gate reads and edits; instructions keep provenance and verification", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Care");
				const relative = yield* openFamilyDb(config);
				yield* Effect.promise(() =>
					owner.connection.reducers.addFamilyMember({
						familyId: BigInt(familyId),
						member: Identity.fromString(relative.identity),
					}),
				);
				const app = familyApp(owner, familyId, careProfileRoutes());
				const theirs = familyApp(relative, familyId, careProfileRoutes());
				const grant = (identity: string, scope: string, granted = true) =>
					({ identity, scope, granted }) as const;

				// Membership alone grants nothing, and only the founder may set sharing up.
				expect(failure(yield* send(app, "GET", "/care-profile"))).toEqual([
					403,
					"forbidden",
				]);
				const grab = grant(relative.identity, "family_access");
				expect(
					failure(yield* send(theirs, "POST", "/care-access", grab)),
				).toEqual([403, "forbidden"]);
				for (const scope of [
					"family_access",
					"health_records",
					"care_plan_edit",
				])
					expect(
						(yield* send(
							app,
							"POST",
							"/care-access",
							grant(owner.identity, scope),
						)).status,
					).toBe(204);

				// Before the first save every fact is unknown.
				const empty = Schema.decodeUnknownSync(CareProfileRecord)(
					(yield* send(app, "GET", "/care-profile")).json,
				);
				expect(empty.profile.allergies).toBeNull();
				expect(empty.editedBy).toBeNull();

				expect((yield* send(app, "PUT", "/care-profile", profile)).status).toBe(
					204,
				);
				const saved = Schema.decodeUnknownSync(CareProfileRecord)(
					(yield* send(app, "GET", "/care-profile")).json,
				);
				expect(saved.profile).toEqual(profile);
				expect(saved.editedBy).toBe(owner.identity);
				expect(saved.history).toHaveLength(1);

				// A new instruction is unverified and is not read to the wearer.
				expect(
					(yield* send(app, "POST", "/care-instructions", dose("1 tablet")))
						.status,
				).toBe(204);
				const [first] = yield* instructions(app);
				expect(first?.verification).toBe("unverified");
				expect(first?.timeZone).toBe("Europe/London");
				expect(first?.editedBy).toBe(owner.identity);
				const verify = (id = "") =>
					send(app, "POST", `/care-instructions/${id}/verify`);
				expect((yield* verify(first?.id)).status).toBe(204);

				// A change waits for verification; the verified version stays in effect.
				yield* send(app, "POST", "/care-instructions", dose("2 tablets"));
				const pending = yield* instructions(app);
				expect(pending.map((i) => [i.instruction, i.verification])).toEqual([
					["2 tablets", "conflicting"],
					["1 tablet", "verified"],
				]);
				const prompt = Schema.decodeUnknownSync(CarePrompt)(
					(yield* send(app, "GET", "/care-profile/prompt")).json,
				).lines;
				expect(prompt).toContain(
					"Synthetic A: your saved instruction says “1 tablet” at 08:00. Source: pharmacy label, from 2026-10-01.",
				);
				expect(prompt.join("\n")).not.toContain("2 tablets");
				expect(prompt).toContain("Allergies: synthetic-penicillin.");
				expect(prompt).toContain("Drink restrictions: unknown.");
				expect(prompt).toContain("Food restrictions: none recorded.");
				expect(prompt).toContain(
					"People to call, in order: Synthetic Ana (daughter); Synthetic Ben.",
				);

				// Verifying the change retires the old version; it cannot be verified back.
				yield* verify(pending[0]?.id);
				expect((yield* instructions(app)).map((i) => i.verification)).toEqual([
					"verified",
					"stale",
				]);
				yield* send(app, "POST", "/care-instructions", dose("3 tablets"));
				yield* send(app, "POST", "/care-instructions", dose("4 tablets"));
				const [four, three] = yield* instructions(app);
				yield* verify(four?.id);
				expect(failure(yield* verify(three?.id))).toEqual([
					400,
					"invalid_request",
				]);
				expect(failure(yield* verify("x"))).toEqual([404, "not_found"]);

				// The relative reads nothing until granted, and never edits without care_plan_edit.
				expect(
					failure(yield* send(theirs, "GET", "/care-instructions")),
				).toEqual([403, "forbidden"]);
				expect(
					failure(yield* send(theirs, "PUT", "/care-profile", profile)),
				).toEqual([403, "forbidden"]);
				expect(
					failure(yield* send(theirs, "POST", "/care-instructions", dose("x"))),
				).toEqual([403, "forbidden"]);
				yield* send(
					app,
					"POST",
					"/care-access",
					grant(relative.identity, "health_records"),
				);
				const shared = yield* until(theirs, "/care-profile", 200);
				expect(
					Schema.decodeUnknownSync(CareProfileRecord)(shared.json).profile,
				).toEqual(profile);
				const relativeVerify = `/care-instructions/${three?.id}/verify`;
				expect(failure(yield* send(theirs, "POST", relativeVerify))).toEqual([
					403,
					"forbidden",
				]);

				// A revoke stops the next read, in the database view as well as the route.
				yield* send(
					app,
					"POST",
					"/care-access",
					grant(relative.identity, "health_records", false),
				);
				const revoked = yield* until(theirs, "/care-profile", 403);
				expect(failure(revoked)).toEqual([403, "forbidden"]);
				expect([...relative.connection.db.myCareInstructions.iter()]).toEqual(
					[],
				);
			}),
		));

	test("another family's identity cannot read or edit the care plan", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(
					config,
					"Private care",
				);
				const app = familyApp(owner, familyId, careProfileRoutes());
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
				yield* send(app, "POST", "/care-instructions", dose("1 tablet"));
				const [mine] = yield* instructions(app);

				const { db: other } = yield* openFamily(config, "Other care");
				const outsider = familyApp(other, familyId, careProfileRoutes());
				const denied = [
					yield* send(outsider, "GET", "/care-profile"),
					yield* send(outsider, "GET", "/care-instructions"),
					yield* send(outsider, "PUT", "/care-profile", profile),
					yield* send(
						outsider,
						"POST",
						"/care-instructions",
						dose("9 tablets"),
					),
					yield* send(
						outsider,
						"POST",
						`/care-instructions/${mine?.id}/verify`,
					),
					yield* send(outsider, "POST", "/care-access", {
						identity: other.identity,
						scope: "care_plan_edit",
						granted: true,
					}),
				];
				expect(denied.map(failure)).toEqual(
					denied.map(() => [403, "forbidden"]),
				);
				expect(
					(yield* instructions(app)).map((i) => [
						i.instruction,
						i.verification,
					]),
				).toEqual([["1 tablet", "unverified"]]);
			}),
		));
});
