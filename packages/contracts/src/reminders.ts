import { Schema } from "effect";
import { isTimeZone } from "./ask";
import { DbId, UtcTime } from "./families";

// The one reminder lifecycle (issue #28), under `/api/families/:familyId`. Medication (#31), meals
// and drinks (#32), bedtime (#37), appointments, and charging are reminder kinds on it; a feature
// keeps only its own evidence, linked by occurrence id, and never adds a second reminder model.
//
// The database schedules every prompt itself, so a server restart neither loses nor repeats one.
// Silence never escalates: an unanswered occurrence ends `unresolved`, and nothing here contacts
// anyone or dispatches help.

/** A wall-clock time in the wearer's time zone, `HH:MM` (24-hour). */
export const LocalTime = Schema.String.check(
	Schema.isPattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
);
export type LocalTime = typeof LocalTime.Type;

const Minutes = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 240 }),
);

const ClientId = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]+$/),
	Schema.isMaxLength(128),
);

/**
 * `GET|PUT /reminder-settings`: the wearer's prompt rules, one set per family. A prompt that falls in
 * quiet hours waits until they end. An unanswered or only acknowledged prompt is repeated every
 * `repeatEveryMinutes`, at most `maxPrompts` times in a row; then the occurrence is `unresolved`.
 */
export const ReminderSettings = Schema.Struct({
	/** IANA zone, such as `America/New_York`. Reminder times follow its daylight-saving changes. */
	timeZone: Schema.String.check(isTimeZone),
	/** `null`: no quiet hours. `start` after `end` spans midnight, such as 22:00 to 07:00. */
	quietHours: Schema.NullOr(
		Schema.Struct({ start: LocalTime, end: LocalTime }),
	),
	repeatEveryMinutes: Minutes,
	maxPrompts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
	/** The delay after "later". */
	snoozeMinutes: Minutes,
});
export type ReminderSettings = typeof ReminderSettings.Type;

/** `GET /reminder-settings`. `null` until a member saves them; reminders need them first. */
export const SavedReminderSettings = Schema.Struct({
	settings: Schema.NullOr(ReminderSettings),
});
export type SavedReminderSettings = typeof SavedReminderSettings.Type;

export const ReminderKind = Schema.Literals([
	"medication",
	"meal",
	"hydration",
	"appointment",
	"charging",
	"routine",
]);
export type ReminderKind = typeof ReminderKind.Type;

/** `POST /reminders`: a saved reminder, prompted daily at each local time. */
export const ReminderInput = Schema.Struct({
	kind: ReminderKind,
	/** What the reminder is about in its own feature, such as a #26 medication instruction id. */
	subjectId: Schema.NullOr(
		Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
	),
	title: Schema.String.check(
		Schema.isTrimmed(),
		Schema.isNonEmpty(),
		Schema.isMaxLength(200),
	),
	times: Schema.Array(LocalTime).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(12),
	),
});
export type ReminderInput = typeof ReminderInput.Type;

export const Reminder = Schema.Struct({
	id: DbId,
	familyId: DbId,
	...ReminderInput.fields,
	createdBy: Schema.String,
	createdAt: UtcTime,
});
export type Reminder = typeof Reminder.Type;

/** `GET /reminders`. `DELETE /reminders/:reminderId` stops future occurrences; history stays. */
export const Reminders = Schema.Struct({ reminders: Schema.Array(Reminder) });
export type Reminders = typeof Reminders.Type;

/**
 * Each state is distinct. `acknowledged` says only that the prompt was seen, never that the task
 * was done. `self_reported_complete` (the wearer's word) and `caregiver_confirmed` (a member's word)
 * stay separate. `unresolved` means no answer settled it; it is never "missed" and never "done".
 */
export const ReminderState = Schema.Literals([
	"scheduled",
	"delivered",
	"acknowledged",
	"self_reported_complete",
	"caregiver_confirmed",
	"deferred",
	"declined",
	"unresolved",
]);
export type ReminderState = typeof ReminderState.Type;

/**
 * The wearer's answer and the state it records:
 * - `okay`, `dismissed` (a dismissed vibration): `acknowledged`; follow-up prompts continue.
 * - `done`, `already_did_it`: `self_reported_complete`; prompts end.
 * - `later`: `deferred` for `snoozeMinutes`. `not_now`: `deferred` for `repeatEveryMinutes`.
 * - `stop`: `declined`; prompts end for this occurrence. The saved reminder stays.
 * - `help`: `unresolved`; prompts end so a person can take over (help path: #34).
 * - `unsure` ("I don't remember if I took it"): `unresolved`; prompts end. Never complete or missed.
 * - `repeat`: no state change; the prompt is due again at once.
 */
export const ReminderResponse = Schema.Literals([
	"okay",
	"dismissed",
	"done",
	"already_did_it",
	"later",
	"not_now",
	"stop",
	"help",
	"unsure",
	"repeat",
]);
export type ReminderResponse = typeof ReminderResponse.Type;

/** Where an answer came from. `scheduler` is the database itself; clients never send it. */
export const ReminderSource = Schema.Literals([
	"scheduler",
	"phone",
	"web",
	"glasses",
]);
export type ReminderSource = typeof ReminderSource.Type;

const ClientSource = Schema.Literals(["phone", "web", "glasses"]);

const Wording = Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000)));

/** One recorded step of an occurrence. Events are never changed or removed. */
export const ReminderEvent = Schema.Struct({
	id: DbId,
	occurrenceId: DbId,
	/** The occurrence state this event recorded. */
	state: ReminderState,
	response: Schema.NullOr(ReminderResponse),
	at: UtcTime,
	/** A member identity (hex), or `scheduler` for the database. */
	actor: Schema.String,
	source: ReminderSource,
	/** The person's original words, verbatim, when they gave any. */
	wording: Wording,
});
export type ReminderEvent = typeof ReminderEvent.Type;

/** One scheduled time of one reminder. Its id is stable from the moment it is scheduled. */
export const ReminderOccurrence = Schema.Struct({
	id: DbId,
	reminderId: DbId,
	familyId: DbId,
	kind: ReminderKind,
	subjectId: Schema.NullOr(Schema.String),
	title: Schema.String,
	/** The local reminder time as a UTC instant, fixed when scheduled. */
	scheduledFor: UtcTime,
	state: ReminderState,
	/** True while a prompt waits for a device to show it (then `POST …/deliveries`). */
	promptDue: Schema.Boolean,
	/** Prompts given since the last answer that reset the follow-up count. */
	prompts: Schema.Int,
	/** When the database prompts next; `null` once prompts have ended. */
	nextPromptAt: Schema.NullOr(UtcTime),
});
export type ReminderOccurrence = typeof ReminderOccurrence.Type;

/** `GET /reminder-occurrences/:occurrenceId`, and the reply to every occurrence write. Events oldest first. */
export const ReminderOccurrenceDetail = Schema.Struct({
	occurrence: ReminderOccurrence,
	events: Schema.Array(ReminderEvent),
});
export type ReminderOccurrenceDetail = typeof ReminderOccurrenceDetail.Type;

/** `GET /reminder-occurrences`: the family history, newest scheduled first, at most 200. */
export const ReminderHistory = Schema.Struct({
	occurrences: Schema.Array(ReminderOccurrenceDetail),
});
export type ReminderHistory = typeof ReminderHistory.Type;

/**
 * `POST /reminder-occurrences/:occurrenceId/deliveries`: a device showed or spoke the due prompt.
 * `clientId` is made once and reused on every resend, so a retry records one event.
 */
export const ReminderDeliveryInput = Schema.Struct({
	clientId: ClientId,
	source: ClientSource,
});
export type ReminderDeliveryInput = typeof ReminderDeliveryInput.Type;

/**
 * `POST /reminder-occurrences/:occurrenceId/answers`. A retried `clientId` returns the first event.
 * A completed occurrence records no second completion. After prompts end, only `done` and
 * `already_did_it` still record (a late self-report); other answers fail with `conflict`.
 */
export const ReminderAnswerInput = Schema.Struct({
	clientId: ClientId,
	source: ClientSource,
	response: ReminderResponse,
	wording: Wording,
});
export type ReminderAnswerInput = typeof ReminderAnswerInput.Type;

/** `POST /reminder-occurrences/:occurrenceId/confirmations`: a caregiver confirms it was done. Once per occurrence. */
export const ReminderConfirmationInput = Schema.Struct({
	clientId: ClientId,
	source: ClientSource,
	wording: Wording,
});
export type ReminderConfirmationInput = typeof ReminderConfirmationInput.Type;
