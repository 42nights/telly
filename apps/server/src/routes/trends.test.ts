// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic.
import { describe, expect, test } from "bun:test";
import { CareInstructions } from "@health/contracts/care-profile";
import { TrendExplanation } from "@health/contracts/trends";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { Timestamp } from "spacetimedb";
import { readFamilyRecords } from "../db";
import type { FamilyEnv } from "../http";
import { careProfileRoutes } from "./care-profile";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	setOwnScopes,
	withDb,
} from "./test-family";
import { trendRoutes } from "./trends";

describe.skipIf(dbConfig === undefined)("trend explanations", () => {
	test("explain only the asked family's records and write nothing", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Trend family");
				yield* Effect.promise(() =>
					db.connection.reducers.createFamily({ name: "Other family" }),
				);
				const other = readFamilyRecords(db).families.find(
					(f) => f.name === "Other family",
				);
				if (other === undefined) throw new Error("no second family");
				const record = (id: string, metric: string, value: number) =>
					Effect.promise(() =>
						db.connection.reducers.recordSample({
							familyId: BigInt(id),
							metric,
							value,
							unit: "ms",
							sourceTime: Timestamp.fromDate(new Date()),
							source: "synthetic-demo",
							synthetic: true,
							quality: { tag: "Unvalidated" },
						}),
					);
				yield* record(familyId, "hrv", 42);
				yield* record(other.id, "rhr", 61);
				const before = readFamilyRecords(db);
				const app = familyApp(db, familyId, trendRoutes(undefined));

				const reply = yield* send(app, "POST", "/trends", {
					question: "Is his sleep getting worse?",
				});
				expect(reply.status).toBe(200);
				const trend = Schema.decodeUnknownSync(TrendExplanation)(reply.json);
				expect(trend.observations.map((o) => [o.kind, o.label])).toEqual([
					["reported", "question"],
					["measured", "hrv"],
				]);
				expect(trend.unknown).toContain(
					"Lab results: FinchNode is not set up on this server.",
				);
				const after = readFamilyRecords(db);
				expect(after.alerts).toEqual(before.alerts);
				expect(after.messages).toEqual(before.messages);

				const bad = yield* send(app, "POST", "/trends", {
					question: "x",
					days: 0,
				});
				expect(failure(bad)).toEqual([400, "invalid_request"]);
			}),
		));

	test("a lab outage leaves the labs unknown; the other records still answer", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Lab outage");
				yield* Effect.promise(() =>
					db.connection.reducers.linkFinchnodeSubject({
						familyId: BigInt(familyId),
						subject: "synthetic-subject",
						synthetic: true,
					}),
				);
				// Nothing listens on port 1, so the lab request fails at once.
				const down = trendRoutes({
					kind: "api",
					baseUrl: "http://127.0.0.1:1",
					apiKey: "ck_test_outage",
					synthetic: true,
				});
				const reply = yield* send(
					familyApp(db, familyId, down),
					"POST",
					"/trends",
					{
						question: "Is his sleep getting worse?",
					},
				);
				expect(reply.status).toBe(200);
				const trend = Schema.decodeUnknownSync(TrendExplanation)(reply.json);
				expect(trend.unknown).toContain(
					"Lab results: Finchnode did not respond",
				);
				expect(trend.observations.map((o) => o.label)).toEqual(["question"]);
			}),
		));

	test("offer only agreed routines and verified care instructions, if shared", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Care trend");
				const app = familyApp(
					db,
					familyId,
					new Hono<FamilyEnv>()
						.route("/", careProfileRoutes())
						.route("/", trendRoutes(undefined)),
				);
				const ask = () =>
					send(app, "POST", "/trends", { question: "Why is HRV down?" }).pipe(
						Effect.map(
							(r) =>
								Schema.decodeUnknownSync(TrendExplanation)(r.json).carePlan,
						),
					);

				// No `health_records` grant: nothing is read and nothing leaks.
				yield* setOwnScopes(db, familyId, ["health_records"], false);
				expect((yield* ask()).status).toBe("not_shared");

				yield* setOwnScopes(db, familyId, ["health_records"], true);
				yield* send(app, "PUT", "/care-profile", {
					preferredName: null,
					language: null,
					timeZone: "Europe/London",
					accessibilityNeeds: null,
					diagnoses: null,
					allergies: null,
					dietaryRestrictions: null,
					fluidRestrictions: null,
					activityRestrictions: null,
					routines: [{ name: "Evening walk", time: "18:00" }],
					contacts: null,
					familiarDestinations: null,
					devices: null,
					declinedPrompts: [],
				});
				const add = (kind: string, name: string) =>
					send(app, "POST", "/care-instructions", {
						kind,
						name,
						instruction: `Synthetic ${name}`,
						times: ["08:00"],
						reason: null,
						source: "discharge sheet",
						effectiveDate: "2026-09-01",
					});
				yield* add("care", "Breathing exercise");
				yield* add("care", "Leg check");
				yield* add("medication", "Synthetic tablet");
				const { instructions } = Schema.decodeUnknownSync(CareInstructions)(
					(yield* send(app, "GET", "/care-instructions")).json,
				);
				for (const i of instructions)
					if (i.name !== "Leg check")
						yield* send(app, "POST", `/care-instructions/${i.id}/verify`);

				const plan = yield* ask();
				expect(plan.status).toBe("shared");
				expect(plan.routines).toEqual([
					{ name: "Evening walk", time: "18:00", timeZone: "Europe/London" },
				]);
				expect(plan.instructions).toEqual([
					{
						name: "Breathing exercise",
						instruction: "Synthetic Breathing exercise",
						times: ["08:00"],
						timeZone: "Europe/London",
						source: "discharge sheet",
						effectiveDate: "2026-09-01",
					},
				]);
				expect(plan.notes).toContain(
					"Leg check (unverified, discharge sheet, 2026-09-01): not verified, ask your caregiver.",
				);
				expect(JSON.stringify(plan)).not.toContain("tablet");
			}),
		));
});
