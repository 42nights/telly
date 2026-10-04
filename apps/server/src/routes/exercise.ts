// Guided exercise routes (#41), mounted at `/api/families/:familyId`. The module's reducers check
// membership, plan verification, and the order of session events again, so a retry or a race cannot
// record a session twice or complete one that never started. Verifying a plan reads the #26 care
// profile, so it needs `health_records` access.
import {
	type ExerciseDemand,
	ExerciseEventInput,
	ExerciseEventKind,
	type ExercisePlan,
	ExercisePlanInput,
	type ExerciseRecords,
	type ExerciseSession,
	StopReason,
} from "@health/contracts/exercise";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import { readProfile } from "./care-profile";

const PlanBody = Schema.fromJsonString(ExercisePlanInput);

// ponytail: keyword match on the profile's free-text restrictions. A restriction that names no
// demand is left to the verifier, who can read the profile. Upgrade when #26 records demands.
const demandWords: Record<ExerciseDemand, RegExp> = {
	standing: /\bstand(s|ing)?\b/i,
	walking: /\bwalk(s|ing)?\b/i,
	floor: /\bfloor\b/i,
	overhead_arms: /\boverhead\b/i,
	weights: /\b(weights?|lift(s|ing)?)\b/i,
};

const readPlans = (c: Context<FamilyEnv>): ExercisePlan[] =>
	[...c.var.db.connection.db.myExercisePlans.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.map((row) => ({
			id: row.id,
			...Schema.decodeUnknownSync(PlanBody)(row.plan),
			createdBy: row.createdBy.toHexString(),
			createdAt: row.createdAt.toISOString(),
			verification:
				row.verifiedBy === undefined || row.verifiedAt === undefined
					? null
					: {
							verifiedBy: row.verifiedBy.toHexString(),
							verifiedAt: row.verifiedAt.toISOString(),
						},
		}))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Each session's outcome from its events. Only a recorded `completed` makes it completed. */
const readSessions = (c: Context<FamilyEnv>): ExerciseSession[] => {
	const sessions = new Map<string, ExerciseSession>();
	const events = [...c.var.db.connection.db.myExerciseEvents.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.sort((a, b) => a.at.toISOString().localeCompare(b.at.toISOString()));
	for (const row of events) {
		const kind = Schema.decodeUnknownSync(ExerciseEventKind)(row.kind);
		const at = row.at.toISOString();
		const session = sessions.get(row.sessionId) ?? {
			sessionId: row.sessionId,
			planId: row.planId,
			outcome: "unfinished",
			reason: null,
			help: false,
			openedAt: at,
			endedAt: null,
		};
		const ended =
			kind === "declined" || kind === "stopped" || kind === "completed";
		sessions.set(row.sessionId, {
			...session,
			...(ended ? { outcome: kind, endedAt: at } : {}),
			reason:
				row.reason === undefined
					? session.reason
					: Schema.decodeUnknownSync(StopReason)(row.reason),
			help: session.help || kind === "help",
		});
	}
	return [...sessions.values()].sort((a, b) =>
		b.openedAt.localeCompare(a.openedAt),
	);
};

const findPlan = (c: Context<FamilyEnv>, id: string) => {
	const plan = readPlans(c).find((row) => row.id === id);
	if (plan === undefined)
		throw new ApiFailure("not_found", "No such exercise plan in this family");
	return plan;
};

/** Plans are created, then verified; the wearer's sessions record one event at a time. */
export const exerciseRoutes = () =>
	new Hono<FamilyEnv>()
		.get("/exercise", (c) =>
			c.json({
				plans: readPlans(c),
				sessions: readSessions(c),
			} satisfies ExerciseRecords),
		)
		.post("/exercise/plans", async (c) => {
			const plan = await decodeBody(c, ExercisePlanInput);
			const id = crypto.randomUUID();
			await callReducer(c.var.db, (connection) =>
				connection.reducers.createExercisePlan({
					id,
					familyId: c.var.familyId,
					plan: Schema.encodeSync(PlanBody)(plan),
				}),
			);
			return c.json(findPlan(c, id) satisfies ExercisePlan, 201);
		})
		.post("/exercise/plans/:planId/verify", async (c) => {
			const { id, demands } = findPlan(c, c.req.param("planId"));
			const { activityRestrictions } = readProfile(c).profile;
			if (activityRestrictions === null)
				throw new ApiFailure(
					"conflict",
					"Record the wearer's activity restrictions in the care profile first",
				);
			const clash = activityRestrictions.find((text) =>
				demands.some((demand) => demandWords[demand].test(text)),
			);
			if (clash !== undefined)
				throw new ApiFailure(
					"conflict",
					`The activity conflicts with the care profile restriction “${clash}”`,
				);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.verifyExercisePlan({ id }),
			);
			return c.json(findPlan(c, id) satisfies ExercisePlan);
		})
		.post("/exercise/events", async (c) => {
			const event = await decodeBody(c, ExerciseEventInput);
			const plan = findPlan(c, event.planId);
			if (plan.verification === null)
				throw new ApiFailure(
					"conflict",
					"Verify the exercise plan before it is offered",
				);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.recordExerciseEvent({
					...event,
					reason: event.reason ?? undefined,
				}),
			);
			const session = readSessions(c).find(
				(row) => row.sessionId === event.sessionId,
			);
			if (session === undefined)
				throw new Error("the recorded event is not visible to its sender");
			return c.json(session satisfies ExerciseSession, 201);
		});
