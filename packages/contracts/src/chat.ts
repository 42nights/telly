// Family chat: family messages and the records a family answer cites, under `/api/families/:familyId`.
import { Schema } from "effect";
import { Alert, FamilyMessage, HealthSample } from "./index";

/**
 * `POST /messages` body. The client creates `clientId` once per message and reuses it for every
 * resend, so a send repeated after a lost reply stores the message once.
 */
export const SendFamilyMessage = Schema.Struct({
	clientId: Schema.String.check(
		Schema.isPattern(/^[A-Za-z0-9_-]+$/),
		Schema.isMaxLength(128),
	),
	body: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000)),
});
export type SendFamilyMessage = typeof SendFamilyMessage.Type;

/** `GET /messages?after=<id>`: the family's messages after that id, oldest first, at most 200. */
export const FamilyMessages = Schema.Struct({
	messages: Schema.Array(FamilyMessage),
});
export type FamilyMessages = typeof FamilyMessages.Type;

/** A sample a family answer read. `stale` is true when the source time is over 24 hours old. */
export const Evidence = Schema.Struct({
	...HealthSample.fields,
	stale: Schema.Boolean,
});
export type Evidence = typeof Evidence.Type;

/**
 * What the family tools returned for one answer, filled by the server and not by the model. Put it
 * in the answer reply so a client can show source and freshness.
 */
export const CitedRecords = Schema.Struct({
	evidence: Schema.Array(Evidence),
	alerts: Schema.Array(Alert),
	/** What had no records: a metric, or `health_samples` for any metric. */
	unavailable: Schema.Array(Schema.String),
});
export type CitedRecords = typeof CitedRecords.Type;
