import { Schema } from "effect";
import { TimeZone } from "./care-profile";
import { IdentityHex, UtcTime } from "./families";
import { FinchnodeLab, ReportMarker } from "./reports";

// Appointment preparation and clinician-update consent (#44, docs/board.html#wf-lab). Nothing here
// books a visit or reaches a provider: requests, provider confirmations, and clinician updates are
// records that a family member makes. Scheduling and hospital delivery stay simulated until a
// provider path is approved (docs/plan.md, "Reports").

const Text = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isNonEmpty(),
	Schema.isMaxLength(500),
);
const Note = Schema.NullOr(Text);
const List = Schema.Array(Text).check(Schema.isMaxLength(30));

/**
 * What a visit is: set once when it is suggested and never changed, so a request or a provider
 * confirmation always refers to the visit as it was proposed. A different time is a new suggestion.
 */
export const AppointmentVisit = Schema.Struct({
	title: Text,
	clinician: Note,
	location: Note,
	/** The visit's start as a UTC instant. */
	startsAt: UtcTime,
	/** The zone the visit takes place in; clients show `startsAt` in this zone. */
	timeZone: TimeZone,
});
export type AppointmentVisit = typeof AppointmentVisit.Type;

/** Preparation that a member records and changes at any time until the visit is cancelled. */
export const AppointmentPrep = Schema.Struct({
	/** How the wearer gets there, such as "Daughter drives, leave 09:15". `null`: not arranged. */
	transportation: Note,
	/** Reminder lead times in minutes before `startsAt`. Their lifecycle belongs to reminders (#28). */
	reminders: Schema.Array(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20160 })),
	).check(Schema.isMaxLength(5)),
	symptoms: List,
	/** Doses or medicines the family is unsure about. */
	medication: List,
	eatingSleep: List,
	questions: List,
});
export type AppointmentPrep = typeof AppointmentPrep.Type;

/** `POST /api/families/:familyId/appointments`: a suggestion. It is never a booking. */
export const NewAppointment = Schema.Struct({
	/** `model`: proposed by an assistant. `member`: proposed by a family member. */
	source: Schema.Literals(["model", "member"]),
	visit: AppointmentVisit,
	prep: AppointmentPrep,
});
export type NewAppointment = typeof NewAppointment.Type;

/** `POST …/appointments/:id/request`: a member's explicit confirmation to request this visit. */
export const AppointmentRequest = Schema.Struct({
	confirm: Schema.Literal(true),
});
export type AppointmentRequest = typeof AppointmentRequest.Type;

/**
 * `POST …/appointments/:id/confirmation`: the provider's own confirmation, as a member received it.
 * Only a requested visit accepts one; a suggestion or a request alone is never a booking.
 */
export const ProviderConfirmation = Schema.Struct({
	/** The provider's booking reference. */
	reference: Text,
	receivedVia: Schema.Literals(["phone", "email", "letter", "portal"]),
});
export type ProviderConfirmation = typeof ProviderConfirmation.Type;

const Stamp = Schema.Struct({ by: IdentityHex, at: Schema.String });

/**
 * The summary a member reviewed before any clinician update: dated evidence and the recorded
 * concerns. `labs` and `observations` are `null` when their source was unavailable, never empty.
 */
export const PrepSummary = Schema.Struct({
	/** Finchnode laboratory results as the source dated them (#8). */
	labs: Schema.NullOr(Schema.Array(FinchnodeLab)),
	/** The latest reviewed lab report's markers (#17). */
	observations: Schema.NullOr(
		Schema.Struct({
			reportId: Schema.String,
			reviewedAt: Schema.String,
			markers: Schema.Array(ReportMarker),
		}),
	),
	symptoms: List,
	medication: List,
	eatingSleep: List,
	questions: List,
});
export type PrepSummary = typeof PrepSummary.Type;

/** `suggested` → `requested` → `confirmed`; `cancelled` from any of them. */
export const AppointmentStatus = Schema.Literals([
	"suggested",
	"requested",
	"confirmed",
	"cancelled",
]);
export type AppointmentStatus = typeof AppointmentStatus.Type;

export const Appointment = Schema.Struct({
	id: Schema.String,
	familyId: Schema.String,
	status: AppointmentStatus,
	visit: AppointmentVisit,
	prep: AppointmentPrep,
	suggestion: Schema.Struct({
		...Stamp.fields,
		source: Schema.Literals(["model", "member"]),
	}),
	/** A member's recorded request. Simulated: nothing reached the provider. */
	request: Schema.NullOr(Stamp),
	confirmation: Schema.NullOr(
		Schema.Struct({ ...Stamp.fields, ...ProviderConfirmation.fields }),
	),
	cancellation: Schema.NullOr(Stamp),
	/** `null` until a member reviews the summary. */
	summary: Schema.NullOr(
		Schema.Struct({ ...Stamp.fields, content: PrepSummary }),
	),
});
export type Appointment = typeof Appointment.Type;

/** `GET /api/families/:familyId/appointments`, soonest first. */
export const Appointments = Schema.Struct({
	appointments: Schema.Array(Appointment),
});
export type Appointments = typeof Appointments.Type;

export const SummarySection = Schema.Literals([
	"labs",
	"observations",
	"symptoms",
	"medication",
	"eatingSleep",
	"questions",
]);
export type SummarySection = typeof SummarySection.Type;

/**
 * `POST /api/families/:familyId/appointments/:id/shares`: consent to send a reviewed summary.
 * `explicit` covers one send of the summary exactly as reviewed. `standing` covers repeated sends at
 * the agreed frequency of the latest reviewed summary, limited to the chosen sections.
 */
export const NewClinicianShare = Schema.Struct({
	recipient: Schema.Struct({ name: Text, role: Note, address: Text }),
	sections: Schema.Array(SummarySection).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(6),
	),
	consent: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("explicit"),
			frequency: Schema.Literal("once"),
		}),
		Schema.Struct({
			kind: Schema.Literal("standing"),
			frequency: Schema.Literals(["weekly", "monthly"]),
		}),
	]),
});
export type NewClinicianShare = typeof NewClinicianShare.Type;

export const ClinicianShare = Schema.Struct({
	...NewClinicianShare.fields,
	id: Schema.String,
	appointmentId: Schema.String,
	approval: Stamp,
	revocation: Schema.NullOr(Stamp),
	/**
	 * Always `simulated`: no clinician delivery path is approved. A send is never a read receipt,
	 * and routine updates are not emergency monitoring.
	 */
	delivery: Schema.Literal("simulated"),
	sends: Schema.Int,
	lastSentAt: Schema.NullOr(Schema.String),
	/** When the next send is allowed; `null` when no further send is allowed. */
	nextSendAt: Schema.NullOr(Schema.String),
});
export type ClinicianShare = typeof ClinicianShare.Type;

/** `GET /api/families/:familyId/appointments/:id/shares`, newest first. */
export const ClinicianShares = Schema.Struct({
	shares: Schema.Array(ClinicianShare),
});
export type ClinicianShares = typeof ClinicianShares.Type;
