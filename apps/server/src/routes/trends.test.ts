// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic.
import { describe, expect, test } from "bun:test";
import { TrendExplanation } from "@health/contracts/trends";
import { Effect, Schema } from "effect";
import { Timestamp } from "spacetimedb";
import { readFamilyRecords } from "../db";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
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
});
