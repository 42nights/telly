// Leaving-home check-in, under `/api/families/:familyId/trips`. No location is sent or stored, so
// the check-in works the same with location permission denied.
import { Schema } from "effect";

/** What started a check-in: the wearer's own request, or a device's departure signal. */
export const TripSource = Schema.Literals(["manual", "departure_signal"]);
export type TripSource = typeof TripSource.Type;

export const TripStep = Schema.Literals([
	"asked",
	"leaving",
	"cancelled",
	"arrived",
]);
export type TripStep = typeof TripStep.Type;

/** The one question a check-in asks. */
export const TRIP_QUESTION = "Are you heading out now?";

const PlanText = Schema.String.check(
	Schema.isPattern(/\S/),
	Schema.isMaxLength(200),
);

/** The wearer's choice of family messages for this trip. Nothing else is sent to the family. */
export const TripNotify = Schema.Struct({
	departure: Schema.Boolean,
	arrival: Schema.Boolean,
});
export type TripNotify = typeof TripNotify.Type;

/** One stored step. Steps are never changed; a changed plan is a later `leaving` step. */
export const TripEvent = Schema.Struct({
	step: TripStep,
	source: TripSource,
	purpose: Schema.NullOr(Schema.String),
	destination: Schema.NullOr(Schema.String),
	/** Hex identity of the member who recorded the step. */
	by: Schema.String,
	at: Schema.String,
});
export type TripEvent = typeof TripEvent.Type;

/** A trip and its history. `plan` is the latest stated plan, for repeat prompts. */
export const Trip = Schema.Struct({
	id: Schema.String,
	status: TripStep,
	source: TripSource,
	plan: Schema.NullOr(
		Schema.Struct({
			purpose: Schema.String,
			destination: Schema.NullOr(Schema.String),
			statedAt: Schema.String,
			statedBy: Schema.String,
		}),
	),
	notify: TripNotify,
	events: Schema.Array(TripEvent),
});
export type Trip = typeof Trip.Type;

/** `GET /trips/current`: the family's latest trip, or null before the first check-in. */
export const CurrentTrip = Schema.Struct({ trip: Schema.NullOr(Trip) });
export type CurrentTrip = typeof CurrentTrip.Type;

/** `POST /trips/check-in` body. */
export const StartTrip = Schema.Struct({ source: TripSource });
export type StartTrip = typeof StartTrip.Type;

/**
 * `POST /trips/check-in` reply. `asked` is false when the check-in was debounced: a trip is still
 * open, or a departure signal repeated soon after the last step. `trip` is then the latest trip.
 */
export const TripCheckIn = Schema.Struct({
	asked: Schema.Boolean,
	question: Schema.String,
	trip: Trip,
});
export type TripCheckIn = typeof TripCheckIn.Type;

/** `POST /trips/:tripId/answer` body. Repeat `leaving` with a new plan when plans change. */
export const TripAnswer = Schema.Union([
	Schema.Struct({
		answer: Schema.Literal("leaving"),
		purpose: PlanText,
		destination: Schema.NullOr(PlanText),
		notify: TripNotify,
		/** The device battery level from 0 to 1, or null when the device does not report it. */
		battery: Schema.NullOr(
			Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
		),
	}),
	Schema.Struct({ answer: Schema.Literals(["cancel", "arrived"]) }),
]);
export type TripAnswer = typeof TripAnswer.Type;

/** `POST /trips/:tripId/answer` reply. `prompt` is the spoken preparation line after `leaving`. */
export const TripReply = Schema.Struct({
	trip: Trip,
	essentials: Schema.Array(Schema.String),
	prompt: Schema.NullOr(Schema.String),
});
export type TripReply = typeof TripReply.Type;
