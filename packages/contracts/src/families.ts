import { Schema } from "effect";
import { Family, SampleQuality } from "./index";

// Family API bodies. Every request body is decoded with excess keys rejected, so a caller cannot
// smuggle a family id, identity, or receive time into a write.

/** A database id (u64) as a decimal string. */
export const DbId = Schema.String.check(
	Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/),
);

/** A database identity as 64 lowercase hex characters. */
export const IdentityHex = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{64}$/),
);

/** An ISO 8601 UTC time, such as `2026-01-01T08:00:00.000Z`. */
export const UtcTime = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/),
);

const Text = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

/**
 * `GET /api/me`: the verified caller. The identity is what family members add. Never a token.
 * `name`, `givenName`, `email`, and `picture` are the ID token's own claims (Google sends them for
 * the `email profile` scopes); each is null when the token does not carry it, never a guess.
 */
export const Me = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	identity: IdentityHex,
	name: Schema.NullOr(Schema.String),
	givenName: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	picture: Schema.NullOr(Schema.String),
});
export type Me = typeof Me.Type;

/**
 * `GET /api/families`: the caller's families. `newestSampleAt` is the source time of the family's
 * newest real (not synthetic) health sample; null or absent means none. The app opens the family
 * with live data first.
 */
export const FamilyList = Schema.Struct({
	families: Schema.Array(
		Schema.Struct({
			...Family.fields,
			newestSampleAt: Schema.optional(Schema.NullOr(UtcTime)),
		}),
	),
});
export type FamilyList = typeof FamilyList.Type;

/** `POST /api/families`: creates a family with the caller as its first member. */
export const NewFamily = Schema.Struct({ name: Text });
export type NewFamily = typeof NewFamily.Type;

/**
 * `DELETE /api/families/:familyId`: deletes the family, every record in it, and its stored files,
 * for good. Only a member with `family_access` may. `name` must be the family's exact name.
 */
export const DeleteFamily = Schema.Struct({ name: Text });
export type DeleteFamily = typeof DeleteFamily.Type;

/** `POST /api/families/:familyId/members`: adds another signed-in person by identity. */
export const NewFamilyMember = Schema.Struct({ identity: IdentityHex });
export type NewFamilyMember = typeof NewFamilyMember.Type;

/**
 * `GET /api/families/:familyId/members`: the people in the family. `name` is the name each person
 * signed in with, stored when they open the app (`GET /api/me`); null until they do.
 */
export const FamilyMembers = Schema.Struct({
	members: Schema.Array(
		Schema.Struct({
			identity: IdentityHex,
			name: Schema.NullOr(Schema.String),
		}),
	),
});
export type FamilyMembers = typeof FamilyMembers.Type;

/**
 * `POST /api/families/:familyId/invites`: a one-time join code, shown once. The database keeps only
 * its SHA-256. It works for one person and ends at `expiresAt` (7 days).
 */
export const FamilyInvite = Schema.Struct({
	code: Schema.String,
	expiresAt: UtcTime,
});
export type FamilyInvite = typeof FamilyInvite.Type;

/** `POST /api/invites/:code/join`: the family the caller is now a member of. */
export const JoinedFamily = Schema.Struct({ family: Family });
export type JoinedFamily = typeof JoinedFamily.Type;

/**
 * `POST /api/families/:familyId/whoop-token`: a push token for this family's WHOOP data, shown once.
 * NOOP pushes to `POST /api/noop/ingest?k=<token>`; the samples go to this family. A new token
 * revokes the family's previous one.
 */
export const WhoopPushToken = Schema.Struct({ token: Schema.String });
export type WhoopPushToken = typeof WhoopPushToken.Type;

/** `POST /api/families/:familyId/samples`: the database sets the receive time and recorder. */
export const NewHealthSample = Schema.Struct({
	metric: Text,
	value: Schema.Finite,
	unit: Text,
	sourceTime: UtcTime,
	source: Text,
	synthetic: Schema.Boolean,
	quality: SampleQuality,
});
export type NewHealthSample = typeof NewHealthSample.Type;

/** A phone number in E.164 form, such as `+15550100123`. */
export const E164 = Schema.String.check(
	Schema.isPattern(/^\+[1-9][0-9]{6,14}$/),
);

/**
 * `GET /api/text-telly`: the Telly line's iMessage number (null when this server has none set up)
 * and the caller's own saved phone number. Telly answers texts from that saved number.
 */
export const TextTelly = Schema.Struct({
	tellyNumber: Schema.NullOr(E164),
	myPhone: Schema.NullOr(E164),
});
export type TextTelly = typeof TextTelly.Type;

/** `PUT /api/me/phone`: saves the caller's phone number, or deletes it with null. */
export const MyPhone = Schema.Struct({ phone: Schema.NullOr(E164) });
export type MyPhone = typeof MyPhone.Type;
