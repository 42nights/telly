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
import { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { openFamilyDb } from "../db";
import type { FamilyEnv } from "../http";
import { alertRoutes } from "./alerts";
import { careProfileRoutes } from "./care-profile";
import { familyRoutes } from "./families";
import { reminderRoutes } from "./reminders";
import { reportRoutes } from "./reports";
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

				// The founder holds every scope from the start (#188). Membership alone grants nothing,
				// and a member without `family_access` cannot grant itself a scope.
				expect((yield* send(app, "GET", "/care-profile")).status).toBe(200);
				expect(failure(yield* send(theirs, "GET", "/care-profile"))).toEqual([
					403,
					"forbidden",
				]);
				const grab = grant(relative.identity, "family_access");
				expect(
					failure(yield* send(theirs, "POST", "/care-access", grab)),
				).toEqual([403, "forbidden"]);

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
				const unverified = Schema.decodeUnknownSync(CarePrompt)(
					(yield* send(app, "GET", "/care-profile/prompt")).json,
				).lines;
				expect(unverified).toContain(
					"Synthetic A is in your plan, but nobody has verified its instruction. Please ask your caregiver.",
				);
				expect(unverified.join("\n")).not.toContain("1 tablet");
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

	test("health records need health_records: an invited relative, a revoke, another family", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Health");
				const routes = () =>
					new Hono<FamilyEnv>()
						.route("/", careProfileRoutes())
						.route("/", alertRoutes())
						.route("/", reportRoutes())
						.route("/", reminderRoutes())
						.route("/", familyRoutes());
				const app = familyApp(owner, familyId, routes());
				const id = BigInt(familyId);
				yield* Effect.promise(() =>
					owner.connection.reducers.recordSample({
						familyId: id,
						metric: "heart_rate",
						value: 70,
						unit: "bpm",
						sourceTime: Timestamp.now(),
						source: "synthetic-watch",
						synthetic: true,
						quality: { tag: "Validated" },
					}),
				);
				yield* Effect.promise(() =>
					owner.connection.reducers.raiseAlert({
						familyId: id,
						sampleId: undefined,
						summary: "Synthetic dizzy spell",
					}),
				);
				yield* Effect.promise(() =>
					owner.connection.reducers.sendMessage({
						familyId: id,
						clientId: "hello",
						body: "Synthetic hello",
					}),
				);
				expect((yield* send(app, "POST", "/reports")).status).toBe(201);
				yield* send(app, "PUT", "/reminder-settings", {
					timeZone: "UTC",
					quietHours: null,
					repeatEveryMinutes: 10,
					maxPrompts: 1,
					snoozeMinutes: 10,
				});
				const reminder = {
					kind: "medication",
					subjectId: null,
					title: "Synthetic pills",
					times: ["08:00"],
				};
				expect((yield* send(app, "POST", "/reminders", reminder)).status).toBe(
					201,
				);

				// The relative joins by invite, as the app does, and holds no care scope.
				const relative = yield* openFamilyDb(config);
				const codeHash = "b".repeat(64);
				yield* Effect.promise(() =>
					owner.connection.reducers.createFamilyInvite({
						familyId: id,
						codeHash,
						expiresAt: Timestamp.fromDate(new Date(Date.now() + 3_600_000)),
					}),
				);
				yield* Effect.promise(() =>
					relative.connection.reducers.joinFamilyByInvite({ codeHash }),
				);
				const theirs = familyApp(relative, familyId, routes());
				const paths = [
					"/alerts",
					"/monitoring",
					"/reports",
					"/reminder-occurrences",
				];
				const reads = (who: Hono<FamilyEnv>) =>
					Effect.forEach(paths, (path) => send(who, "GET", path));
				const rows = (db: typeof relative) => [
					[...db.connection.db.myHealthSamples.iter()].length,
					[...db.connection.db.myAlerts.iter()].length,
					[...db.connection.db.myReports.iter()].length,
					[...db.connection.db.myReminderOccurrences.iter()].length,
				];
				const forbidden = paths.map(() => [403, "forbidden" as const]);
				expect((yield* reads(theirs)).map(failure)).toEqual(forbidden);
				expect(rows(relative)).toEqual([0, 0, 0, 0]);
				// Family chat needs no grant.
				const records = (yield* send(theirs, "GET", "/")).json;
				expect(records).toMatchObject({
					samples: [],
					alerts: [],
					messages: [{ body: "Synthetic hello" }],
				});

				// The founder grants health_records in the care-access screen's route.
				const setGrant = (granted: boolean) =>
					send(app, "POST", "/care-access", {
						identity: relative.identity,
						scope: "health_records",
						granted,
					});
				yield* setGrant(true);
				yield* until(theirs, "/alerts", 200);
				expect((yield* reads(theirs)).map((r) => r.status)).toEqual(
					paths.map(() => 200),
				);
				expect(rows(relative)).toEqual(rows(owner));
				expect(rows(owner).every((n) => n > 0)).toBe(true);

				// A revoke stops the next read, in the views as well as the routes.
				yield* setGrant(false);
				yield* until(theirs, "/alerts", 403);
				expect((yield* reads(theirs)).map(failure)).toEqual(forbidden);
				expect(rows(relative)).toEqual([0, 0, 0, 0]);

				// Another family's founder holds every scope in its own family only.
				const { db: other } = yield* openFamily(config, "Other health");
				const outsider = familyApp(other, familyId, routes());
				expect((yield* reads(outsider)).map(failure)).toEqual(forbidden);
				expect(rows(other)).toEqual([0, 0, 0, 0]);
			}),
		));
});
