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

/** `GET /api/me`: the verified caller. The identity is what family members add. Never a token. */
export const Me = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	identity: IdentityHex,
});
export type Me = typeof Me.Type;

/** `GET /api/families`: the caller's families. */
export const FamilyList = Schema.Struct({ families: Schema.Array(Family) });
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
