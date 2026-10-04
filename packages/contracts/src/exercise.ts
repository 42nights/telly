// Guided exercise sessions (#41), under `/api/families/:familyId/exercise`. A family member records
// an activity the wearer agreed to, from a named source such as a physiotherapist's handout. The app
// never writes exercise steps itself and never picks or changes an activity from a health reading.
import { Schema } from "effect";
import { IdentityHex, UtcTime } from "./families";

/** What an activity asks of the body. A restriction names a demand the wearer must avoid. */
export const ExerciseDemand = Schema.Literals([
	"standing",
	"walking",
	"floor",
	"overhead_arms",
	"weights",
]);
export type ExerciseDemand = typeof ExerciseDemand.Type;

const Line = (max: number) =>
	Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(max));
/** A local time of day on the wearer's device, `HH:MM`. */
const ClockTime = Schema.String.check(
	Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);
const ClientId = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]+$/),
	Schema.isMaxLength(128),
);

const planFields = {
	activity: Line(80),
	/** Read and shown one at a time, exactly as written in the source. */
	steps: Schema.NonEmptyArray(Line(300)).check(Schema.isMaxLength(20)),
	demands: Schema.Array(ExerciseDemand),
	/** The wearer's recorded activity restrictions. Until #26 lands they are recorded here. */
	restrictions: Schema.Array(ExerciseDemand),
	/** Where the activity was agreed, such as "Physiotherapist handout, 30 Sep". */
	source: Line(200),
	/** The invitation appears only between these local times. */
	windowStart: ClockTime,
	windowEnd: ClockTime,
	/** A video of the activity from the same source. `null` means audio and text only. */
	videoUrl: Schema.NullOr(
		Schema.String.check(
			Schema.isPattern(/^https:\/\/\S+$/),
			Schema.isMaxLength(500),
		),
	),
};

/** `POST /exercise/plans` body. A plan that asks for a restricted demand is refused. */
export const ExercisePlanInput = Schema.Struct(planFields).check(
	Schema.makeFilter(
		(plan) =>
			plan.demands.every((demand) => !plan.restrictions.includes(demand)) ||
			"The activity asks for a demand that a recorded restriction forbids",
	),
);
export type ExercisePlanInput = typeof ExercisePlanInput.Type;

export const ExercisePlan = Schema.Struct({
	id: Schema.String,
	...planFields,
	createdBy: IdentityHex,
	createdAt: UtcTime,
	/** `null` until a member confirms the plan matches its source. Only verified plans are offered. */
	verification: Schema.NullOr(
		Schema.Struct({ verifiedBy: IdentityHex, verifiedAt: UtcTime }),
	),
});
export type ExercisePlan = typeof ExercisePlan.Type;

/**
 * The wearer's answer to an invitation (`declined`, `started`), a control during the session, or
 * its end (`stopped`, `completed`). No answer records nothing.
 */
export const ExerciseEventKind = Schema.Literals([
	"declined",
	"started",
	"paused",
	"resumed",
	"repeated",
	"slowed",
	"help",
	"stopped",
	"completed",
]);
export type ExerciseEventKind = typeof ExerciseEventKind.Type;

/** Why a session stopped: the wearer chose to, or reported pain, dizziness, or distress. */
export const StopReason = Schema.Literals([
	"wearer",
	"pain",
	"dizziness",
	"distress",
]);
export type StopReason = typeof StopReason.Type;

/**
 * `POST /exercise/events` body. The client creates `id` once per event and reuses it for every
 * resend, so an event repeated after a lost reply is stored once. Only `stopped` has a reason.
 */
export const ExerciseEventInput = Schema.Struct({
	id: ClientId,
	planId: Schema.String,
	sessionId: ClientId,
	kind: ExerciseEventKind,
	reason: Schema.NullOr(StopReason),
}).check(
	Schema.makeFilter(
		(event) =>
			(event.kind === "stopped") === (event.reason !== null) ||
			"Only a stopped event has a reason",
	),
);
export type ExerciseEventInput = typeof ExerciseEventInput.Type;

/**
 * One session as stored. `unfinished` means it started and no stop or finish was recorded: it is
 * never counted as completed.
 */
export const ExerciseSession = Schema.Struct({
	sessionId: Schema.String,
	planId: Schema.String,
	outcome: Schema.Literals(["declined", "completed", "stopped", "unfinished"]),
	reason: Schema.NullOr(StopReason),
	/** The wearer asked for help during the session. */
	help: Schema.Boolean,
	openedAt: UtcTime,
	endedAt: Schema.NullOr(UtcTime),
});
export type ExerciseSession = typeof ExerciseSession.Type;

/** `GET /exercise`: plans oldest first, sessions newest first. */
export const ExerciseRecords = Schema.Struct({
	plans: Schema.Array(ExercisePlan),
	sessions: Schema.Array(ExerciseSession),
});
export type ExerciseRecords = typeof ExerciseRecords.Type;
