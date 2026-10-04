// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import {
	type ExerciseEventInput,
	ExercisePlan,
	ExerciseRecords,
	ExerciseSession,
} from "@health/contracts/exercise";
import { Effect, Schema } from "effect";
import { openFamilyDb } from "../db";
import { exerciseRoutes } from "./exercise";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const plan = {
	activity: "Seated marching",
	steps: [
		"Sit tall near the front of a firm chair.",
		"Lift one knee, then the other.",
	],
	demands: [],
	restrictions: ["standing", "floor"],
	source: "Synthetic demo plan",
	windowStart: "09:00",
	windowEnd: "11:00",
	videoUrl: null,
};

const event = (
	planId: string,
	sessionId: string,
	kind: ExerciseEventInput["kind"],
	reason: ExerciseEventInput["reason"] = null,
): ExerciseEventInput => ({
	id: crypto.randomUUID(),
	planId,
	sessionId,
	kind,
	reason,
});

describe.skipIf(dbConfig === undefined)("guided exercise", () => {
	test("only a verified, compatible plan runs, and only a recorded finish completes it", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Exercise family");
				const app = familyApp(db, familyId, exerciseRoutes());

				// A demand that a recorded restriction forbids is refused.
				const conflict = { ...plan, demands: ["standing"] };
				const refused = yield* send(app, "POST", "/exercise/plans", conflict);
				expect(failure(refused)).toEqual([400, "invalid_request"]);

				const created = yield* send(app, "POST", "/exercise/plans", plan);
				expect(created.status).toBe(201);
				const { id: planId } = Schema.decodeUnknownSync(ExercisePlan)(
					created.json,
				);
				const early = yield* send(
					app,
					"POST",
					"/exercise/events",
					event(planId, "s1", "started"),
				);
				expect(failure(early)).toEqual([409, "conflict"]);
				const direct = yield* Effect.promise(() =>
					db.connection.reducers
						.recordExerciseEvent({
							...event(planId, "s1", "started"),
							reason: undefined,
						})
						.then(String, String),
				);
				expect(direct).toBe("SenderError: the exercise plan is not verified");

				const verified = yield* send(
					app,
					"POST",
					`/exercise/plans/${planId}/verify`,
				);
				expect(
					Schema.decodeUnknownSync(ExercisePlan)(verified.json).verification
						?.verifiedBy,
				).toBe(db.identity);

				const record = (body: ExerciseEventInput) =>
					send(app, "POST", "/exercise/events", body);
				// Finishing a session that never started records nothing.
				const unstarted = yield* record(event(planId, "s1", "completed"));
				expect(failure(unstarted)).toEqual([400, "invalid_request"]);

				yield* record(event(planId, "declined", "declined"));
				const afterDecline = yield* record(
					event(planId, "declined", "started"),
				);
				expect(failure(afterDecline)).toEqual([400, "invalid_request"]);

				yield* record(event(planId, "silent", "started"));

				const finish = event(planId, "done", "completed");
				yield* record(event(planId, "done", "started"));
				yield* record(event(planId, "done", "help"));
				const first = yield* record(finish);
				const resent = yield* record(finish);
				expect(resent).toEqual(first);
				const twice = yield* record(event(planId, "done", "completed"));
				expect(failure(twice)).toEqual([400, "invalid_request"]);

				yield* record(event(planId, "hurt", "started"));
				const noReason = yield* record(event(planId, "hurt", "stopped"));
				expect(failure(noReason)).toEqual([400, "invalid_request"]);
				yield* record(event(planId, "hurt", "stopped", "dizziness"));

				const listed = yield* send(app, "GET", "/exercise");
				const { sessions } = Schema.decodeUnknownSync(ExerciseRecords)(
					listed.json,
				);
				const outcome = Object.fromEntries(
					sessions.map((s) => [s.sessionId, [s.outcome, s.reason, s.help]]),
				);
				expect(outcome).toEqual({
					declined: ["declined", null, false],
					silent: ["unfinished", null, false],
					done: ["completed", null, true],
					hurt: ["stopped", "dizziness", false],
				});
				expect(
					Schema.decodeUnknownSync(ExerciseSession)(first.json).outcome,
				).toBe("completed");
			}),
		));

	test("another family's identity cannot read, verify, or record", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Private");
				const outsider = yield* openFamilyDb(config);
				const ownerApp = familyApp(owner, familyId, exerciseRoutes());
				const created = yield* send(ownerApp, "POST", "/exercise/plans", plan);
				const { id } = Schema.decodeUnknownSync(ExercisePlan)(created.json);

				const outsiderApp = familyApp(outsider, familyId, exerciseRoutes());
				const listed = yield* send(outsiderApp, "GET", "/exercise");
				expect(listed.json).toEqual({ plans: [], sessions: [] });

				const theirs = outsider.connection.reducers;
				const writes = [
					theirs.createExercisePlan({
						id: crypto.randomUUID(),
						familyId: BigInt(familyId),
						plan: "{}",
					}),
					theirs.verifyExercisePlan({ id }),
					theirs.recordExerciseEvent({
						...event(id, "s", "started"),
						reason: undefined,
					}),
				];
				const results = yield* Effect.promise(() => Promise.allSettled(writes));
				expect(
					results.map((r) =>
						r.status === "rejected" ? String(r.reason) : r.status,
					),
				).toEqual(writes.map(() => "SenderError: not a member of this family"));

				const after = yield* send(ownerApp, "GET", "/exercise");
				expect(
					Schema.decodeUnknownSync(ExerciseRecords)(after.json).plans[0]
						?.verification,
				).toBeNull();
			}),
		));
});
