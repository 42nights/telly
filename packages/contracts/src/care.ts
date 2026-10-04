// The family contact ladder (issue #30), under `/api/families/:familyId/care`. A care need goes to
// one contact at a time, in ladder order, then the backup. Only acceptance and then confirmed help
// close it: a sent message or an answered call never does. Calls are simulated; nothing leaves the app.
import { Schema } from "effect";
import { DbId, IdentityHex, UtcTime } from "./families";

const Text = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isNonEmpty(),
	Schema.isMaxLength(500),
);

export const NeedKind = Schema.Literals(["alert", "help", "call_reminder"]);
export type NeedKind = typeof NeedKind.Type;

/** What a contact's notice may carry: that a need exists, its summary, or its facts too. */
export const ContactDetail = Schema.Literals(["minimal", "summary", "facts"]);
export type ContactDetail = typeof ContactDetail.Type;

/** One family member on the ladder. `callFor`: need kinds that get a (simulated) call, not a message. */
export const LadderContact = Schema.Struct({
	member: IdentityHex,
	name: Text,
	/** IANA time zone, such as `America/Chicago`. */
	timeZone: Text,
	detail: ContactDetail,
	callFor: Schema.Array(NeedKind),
});
export type LadderContact = typeof LadderContact.Type;

/** `PUT /care/ladder`: contacts in order (1 to 5), an optional backup, and the two wait times. */
export const ContactLadderInput = Schema.Struct({
	contacts: Schema.Array(LadderContact),
	backup: Schema.NullOr(LadderContact),
	/** How long a contact has to accept before the next one is contacted (10 to 86400). */
	answerSeconds: Schema.Int,
	/** How long an accepted need may wait for confirmed help before the ladder continues (10 to 604800). */
	followUpSeconds: Schema.Int,
});
export type ContactLadderInput = typeof ContactLadderInput.Type;

export const ContactLadder = Schema.Struct({
	...ContactLadderInput.fields,
	updatedBy: IdentityHex,
	updatedAt: UtcTime,
});
export type ContactLadder = typeof ContactLadder.Type;

/** `GET /care/ladder`: null until a member sets one. Without a ladder, alerts open no care need. */
export const ContactLadderReply = Schema.Struct({
	ladder: Schema.NullOr(ContactLadder),
});
export type ContactLadderReply = typeof ContactLadderReply.Type;

/** A fact copied from the family's records, with its source, time, and uncertainty. */
export const NeedFact = Schema.Struct({
	text: Schema.String,
	source: Schema.String,
	observedAt: UtcTime,
	uncertainty: Schema.String,
});
export type NeedFact = typeof NeedFact.Type;

/**
 * `queued`: waiting for the due time. `sent`: message posted or simulated call ringing. `delivered`:
 * the contact's app showed it. `answered`: the call was answered; that alone accepts nothing.
 * `follow_up_expired`: accepted, but help was not confirmed in time.
 */
export const AttemptStatus = Schema.Literals([
	"queued",
	"sent",
	"delivered",
	"answered",
	"accepted",
	"declined",
	"no_answer",
	"follow_up_expired",
]);
export type AttemptStatus = typeof AttemptStatus.Type;

export const ContactAttempt = Schema.Struct({
	step: Schema.Int,
	member: IdentityHex,
	name: Schema.String,
	backup: Schema.Boolean,
	channel: Schema.Literals(["call", "message"]),
	status: AttemptStatus,
	/** The notice, with only the detail this contact may receive. */
	body: Schema.String,
	createdAt: UtcTime,
	updatedAt: UtcTime,
	/** `updatedAt` on the contact's clock, such as `Sat 3:04 AM (Asia/Kolkata)`. */
	contactLocalTime: Schema.String,
});
export type ContactAttempt = typeof ContactAttempt.Type;

/** `resolved` (help confirmed) is the only closed state. `unresolved`: nobody accepted; it stays visible. */
export const NeedStatus = Schema.Literals([
	"open",
	"accepted",
	"resolved",
	"unresolved",
]);
export type NeedStatus = typeof NeedStatus.Type;

/** One need, also `GET /care/needs/:needId`. */
export const CareNeed = Schema.Struct({
	id: DbId,
	familyId: DbId,
	kind: NeedKind,
	summary: Schema.String,
	facts: Schema.Array(NeedFact),
	alertId: Schema.NullOr(DbId),
	dueAt: UtcTime,
	status: NeedStatus,
	acceptedBy: Schema.NullOr(IdentityHex),
	followUpBy: Schema.NullOr(UtcTime),
	raisedBy: IdentityHex,
	clientId: Schema.String,
	createdAt: UtcTime,
	updatedAt: UtcTime,
	/** Oldest first. The last one is the current contact. */
	attempts: Schema.Array(ContactAttempt),
	/** Contacts not reached yet, in order. */
	remaining: Schema.Array(Schema.String),
});
export type CareNeed = typeof CareNeed.Type;

/** `GET /care/needs`: newest first. */
export const CareNeeds = Schema.Struct({ needs: Schema.Array(CareNeed) });
export type CareNeeds = typeof CareNeeds.Type;

/**
 * `POST /care/needs`: a request for help or a call reminder (alerts open their own need). Facts come
 * only from the family's samples. Reuse `clientId` on a resend; the need is stored once.
 */
export const NewCareNeed = Schema.Struct({
	clientId: Schema.String.check(
		Schema.isPattern(/^[A-Za-z0-9_-]+$/),
		Schema.isMaxLength(128),
	),
	kind: Schema.Literals(["help", "call_reminder"]),
	summary: Text,
	sampleIds: Schema.Array(DbId),
	/** The first contact is not notified before this time. Null: now. */
	dueAt: Schema.NullOr(UtcTime),
});
export type NewCareNeed = typeof NewCareNeed.Type;

/**
 * `POST /care/needs/:needId/responses`. The current contact sends `seen`, `answer` (calls only),
 * `accept`, or `decline`; the member who accepted sends `help_confirmed`. Repeats change nothing.
 */
export const CareResponse = Schema.Struct({
	response: Schema.Literals([
		"seen",
		"answer",
		"accept",
		"decline",
		"help_confirmed",
	]),
});
export type CareResponse = typeof CareResponse.Type;
