// Emergency help, "Call my family", and the suspected-event check-in (issue #34), under
// `/api/families/:familyId/emergency`. No route places a call: the wearer's phone dials from a
// `tel:` link. These routes alert the family and return what to tell the emergency operator.
import { Schema } from "effect";
import { DbId, UtcTime } from "./families";

const Words = Schema.String.check(
	Schema.isPattern(/\S/),
	Schema.isMaxLength(2000),
);
const PhoneNumber = Schema.String.check(
	Schema.isPattern(/^\+?[0-9()\s.-]{3,24}$/),
);

/** Who is calling for help, when the device knows. Null is "not on file", never a guess. */
export const Wearer = Schema.Struct({
	name: Schema.NullOr(
		Schema.String.check(
			Schema.isTrimmed(),
			Schema.isNonEmpty(),
			Schema.isMaxLength(200),
		),
	),
	callback: Schema.NullOr(PhoneNumber),
});
export type Wearer = typeof Wearer.Type;

/** The device's location fix, or why there is none. */
export const LocationReading = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("fix"),
		latitude: Schema.Finite.check(
			Schema.isBetween({ minimum: -90, maximum: 90 }),
		),
		longitude: Schema.Finite.check(
			Schema.isBetween({ minimum: -180, maximum: 180 }),
		),
		accuracyMeters: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
		capturedAt: UtcTime,
	}),
	Schema.Struct({ status: Schema.Literals(["denied", "unavailable"]) }),
]);
export type LocationReading = typeof LocationReading.Type;

/**
 * Something that might be an emergency. `ouch` and `possible_fall` start a check-in.
 * `missed_reminder` and `unheard_vibration` never start dispatch by themselves.
 * Automatic detection is not a source: it waits on a validated signal (issue #6).
 */
export const SuspectedEvent = Schema.Struct({
	kind: Schema.Literals([
		"ouch",
		"possible_fall",
		"missed_reminder",
		"unheard_vibration",
	]),
	/** The exact words or notice, as observed. */
	report: Words,
	observedAt: UtcTime,
});
export type SuspectedEvent = typeof SuspectedEvent.Type;

/** The events that get a check-in. */
export const CheckInEvent = Schema.Struct({
	...SuspectedEvent.fields,
	kind: Schema.Literals(["ouch", "possible_fall"]),
});
export type CheckInEvent = typeof CheckInEvent.Type;

/** `POST /emergency`: an explicit request for emergency help, for the family, or a suspected event. */
export const EmergencyRequest = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("help"),
		report: Schema.NullOr(Words),
		wearer: Wearer,
		location: LocationReading,
	}),
	Schema.Struct({
		kind: Schema.Literal("family"),
		report: Schema.NullOr(Words),
	}),
	Schema.Struct({ kind: Schema.Literal("event"), event: SuspectedEvent }),
]);
export type EmergencyRequest = typeof EmergencyRequest.Type;

/** A check-in reply. `other` is a voice that is not the wearer, such as a television. */
export const CheckInReply = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("speech"),
		speaker: Schema.Literals(["wearer", "other"]),
		text: Words,
	}),
	Schema.Struct({
		kind: Schema.Literal("no_response"),
		waitedSeconds: Schema.Int.check(
			Schema.isBetween({ minimum: 1, maximum: 600 }),
		),
	}),
]);
export type CheckInReply = typeof CheckInReply.Type;

/** `POST /emergency/check-in`: the reply to a check-in about an `ouch` or `possible_fall` event. */
export const CheckIn = Schema.Struct({
	event: CheckInEvent,
	reply: CheckInReply,
	wearer: Wearer,
	location: LocationReading,
});
export type CheckIn = typeof CheckIn.Type;

/** What to tell the emergency operator. Unknown values stay null or unavailable. */
export const Handoff = Schema.Struct({
	name: Schema.NullOr(Schema.String),
	callback: Schema.NullOr(Schema.String),
	event: Schema.String,
	/** The wearer's exact words, when there are any. */
	report: Schema.NullOr(Schema.String),
	responsiveness: Schema.Literals(["responding", "not_responding"]),
	/**
	 * From the family's care profile (#26). Conditions and allergies are as saved; null is unknown,
	 * `[]` is none recorded. Medications are verified medication instructions only. Unavailable
	 * when the caller has no `health_records` access or the profile cannot be read.
	 */
	care: Schema.Union([
		Schema.Struct({
			status: Schema.Literal("available"),
			conditions: Schema.NullOr(Schema.Array(Schema.String)),
			allergies: Schema.NullOr(Schema.Array(Schema.String)),
			medications: Schema.Array(Schema.String),
			savedAt: Schema.NullOr(Schema.String),
		}),
		Schema.Struct({
			status: Schema.Literal("unavailable"),
			reason: Schema.String,
		}),
	]),
	location: Schema.Union([
		Schema.Struct({
			status: Schema.Literals(["current", "last_known"]),
			latitude: Schema.Finite,
			longitude: Schema.Finite,
			accuracyMeters: Schema.Finite,
			ageSeconds: Schema.Int,
		}),
		Schema.Struct({ status: Schema.Literals(["denied", "unavailable"]) }),
	]),
});
export type Handoff = typeof Handoff.Type;

/** The family alert (issue #5) for this request, or why it was not raised. */
export const FamilyNotice = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("raised"),
		alertId: DbId,
		summary: Schema.String,
	}),
	Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
]);
export type FamilyNotice = typeof FamilyNotice.Type;

/**
 * Reply of both routes. `none` never means safe: missing or normal wearable data cannot confirm it.
 */
export const EmergencyOutcome = Schema.Union([
	Schema.Struct({
		action: Schema.Literal("help"),
		handoff: Handoff,
		family: FamilyNotice,
	}),
	Schema.Struct({ action: Schema.Literal("family"), family: FamilyNotice }),
	Schema.Struct({
		action: Schema.Literal("check_in"),
		prompt: Schema.String,
		event: CheckInEvent,
		/** Why the last reply did not decide: a voice that is not the wearer, or no clear answer. */
		reason: Schema.NullOr(Schema.Literals(["other_voice", "unclear"])),
	}),
	Schema.Struct({
		action: Schema.Literal("none"),
		reason: Schema.Literals(["denied", "not_an_emergency"]),
		safety: Schema.Literal("unconfirmed"),
		family: Schema.NullOr(FamilyNotice),
	}),
]);
export type EmergencyOutcome = typeof EmergencyOutcome.Type;
