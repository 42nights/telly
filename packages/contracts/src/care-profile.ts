import { Schema } from "effect";
import { IdentityHex } from "./families";

// The wearer's care profile, care instructions, and per-recipient sharing (#26,
// docs/board.html#wf-family). Family membership alone grants none of this: each member reads or
// edits only what an explicit grant allows, and the database checks the grant on every read and
// write. `null` always means unknown, never "none": an empty list means someone confirmed none.

const Text = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isNonEmpty(),
	Schema.isMaxLength(500),
);
const Note = Schema.NullOr(Text);
const Known = <S extends Schema.Top>(item: S) =>
	Schema.NullOr(Schema.Array(item).check(Schema.isMaxLength(50)));

/** A local time of day, `HH:MM`, in the profile's `timeZone`. */
export const LocalTime = Schema.String.check(
	Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);

/** A calendar date, `YYYY-MM-DD`. */
export const LocalDate = Schema.String.check(
	Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
);

/** An IANA time zone name, such as `Europe/London`. */
export const TimeZone = Schema.String.check(
	Schema.makeFilter((zone) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: zone });
			return true;
		} catch {
			return "must be an IANA time zone";
		}
	}),
);

/**
 * Separate sharing controls. `health_records`: read the profile and instructions. `care_plan_edit`:
 * change them. `family_access`: change everyone's grants. The others gate their own features
 * (location, photos/audio, clinician delivery, purchases) for the issues that build them.
 */
export const CareScope = Schema.Literals([
	"health_records",
	"care_plan_edit",
	"family_access",
	"location",
	"media",
	"clinician_delivery",
	"purchases",
]);
export type CareScope = typeof CareScope.Type;

/** `PUT /api/families/:familyId/care-profile`: the whole profile; each save is a new version. */
export const CareProfile = Schema.Struct({
	preferredName: Note,
	language: Note,
	timeZone: Schema.NullOr(TimeZone),
	accessibilityNeeds: Known(Text),
	diagnoses: Known(Text),
	allergies: Known(Text),
	dietaryRestrictions: Known(Text),
	fluidRestrictions: Known(Text),
	activityRestrictions: Known(Text),
	routines: Known(
		Schema.Struct({ name: Text, time: Schema.NullOr(LocalTime) }),
	),
	/** In contact order: the first is called first. */
	contacts: Known(
		Schema.Struct({ name: Text, relationship: Note, phone: Note }),
	),
	familiarDestinations: Known(Schema.Struct({ name: Text, address: Note })),
	devices: Known(Text),
	/** Ordinary prompt kinds the wearer declined, such as `meals`. Never medication or safety. */
	declinedPrompts: Schema.Array(Text).check(Schema.isMaxLength(20)),
});
export type CareProfile = typeof CareProfile.Type;

/** `GET /api/families/:familyId/care-profile`. Before the first save every field is unknown. */
export const CareProfileRecord = Schema.Struct({
	familyId: Schema.String,
	profile: CareProfile,
	/** `null` until the first save. */
	editedBy: Schema.NullOr(IdentityHex),
	editedAt: Schema.NullOr(Schema.String),
	/** Every saved version, newest first: who changed the profile and when. */
	history: Schema.Array(
		Schema.Struct({ editedBy: IdentityHex, editedAt: Schema.String }),
	),
});
export type CareProfileRecord = typeof CareProfileRecord.Type;

export const CareInstructionKind = Schema.Literals(["medication", "care"]);
export type CareInstructionKind = typeof CareInstructionKind.Type;

/**
 * `verified`: confirmed against its source and the version in effect for its name.
 * `unverified`: nobody has confirmed it, and no verified version exists.
 * `conflicting`: a newer, unconfirmed version that differs from the verified one; the verified one
 * stays in effect. `stale`: replaced by a later verified version. Only `verified` may be read to
 * the wearer as an instruction.
 */
export const CareVerification = Schema.Literals([
	"verified",
	"unverified",
	"conflicting",
	"stale",
]);
export type CareVerification = typeof CareVerification.Type;

/** `POST /api/families/:familyId/care-instructions`: a new, unverified version. */
export const NewCareInstruction = Schema.Struct({
	kind: CareInstructionKind,
	/** As written on the source. Versions of one instruction share a name (case-insensitive). */
	name: Text,
	/** The prescribed dose and directions, verbatim. Read aloud unchanged. */
	instruction: Schema.String.check(
		Schema.isTrimmed(),
		Schema.isNonEmpty(),
		Schema.isMaxLength(2000),
	),
	times: Schema.Array(LocalTime).check(Schema.isMaxLength(24)),
	/** Why it is taken; `null` when the source does not say. */
	reason: Note,
	/** For example "pharmacy label" or "discharge sheet". */
	source: Text,
	effectiveDate: LocalDate,
});
export type NewCareInstruction = typeof NewCareInstruction.Type;

/** One saved version with its provenance. Rows are never edited; a change is a new version. */
export const CareInstruction = Schema.Struct({
	...NewCareInstruction.fields,
	id: Schema.String,
	familyId: Schema.String,
	/** The profile's time zone for `times`; `null` while unknown. */
	timeZone: Schema.NullOr(Schema.String),
	editedBy: IdentityHex,
	editedAt: Schema.String,
	verification: CareVerification,
	verifiedBy: Schema.NullOr(IdentityHex),
	verifiedAt: Schema.NullOr(Schema.String),
});
export type CareInstruction = typeof CareInstruction.Type;

/** `GET /api/families/:familyId/care-instructions`: every version, newest first. */
export const CareInstructions = Schema.Struct({
	instructions: Schema.Array(CareInstruction),
});
export type CareInstructions = typeof CareInstructions.Type;

/** `POST /api/families/:familyId/care-access`: grants or revokes one scope for one member. */
export const NewCareGrant = Schema.Struct({
	identity: IdentityHex,
	scope: CareScope,
	granted: Schema.Boolean,
});
export type NewCareGrant = typeof NewCareGrant.Type;

export const CareGrantChange = Schema.Struct({
	...NewCareGrant.fields,
	changedBy: IdentityHex,
	changedAt: Schema.String,
});
export type CareGrantChange = typeof CareGrantChange.Type;

/** `GET /api/families/:familyId/care-access`: visible to every member of the family. */
export const CareAccess = Schema.Struct({
	/** The caller's current scopes. */
	mine: Schema.Array(CareScope),
	/** Current grants: the latest change per member and scope that granted access. */
	grants: Schema.Array(CareGrantChange),
	/** Every change, newest first. */
	history: Schema.Array(CareGrantChange),
});
export type CareAccess = typeof CareAccess.Type;

/**
 * `GET /api/families/:familyId/care-profile/prompt`: what the wearer is told, built only from the
 * saved profile and verified instructions. Unknown facts are said to be unknown.
 */
export const CarePrompt = Schema.Struct({ lines: Schema.Array(Schema.String) });
export type CarePrompt = typeof CarePrompt.Type;
