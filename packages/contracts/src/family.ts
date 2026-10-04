// Family messages and family questions, under `/api/families/:familyId`.
import { Schema } from "effect";
import { FamilyMessage, HealthSample } from "./index";

const isTimeZone = Schema.makeFilter((zone: string) => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
});

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

/** `POST /ask` body: a family member's question about the family's records. */
export const FamilyQuestion = Schema.Struct({
	question: Schema.String.check(
		Schema.isPattern(/\S/),
		Schema.isMaxLength(2000),
	),
	/** IANA time zone for times in the answer, such as `Europe/Berlin`. Default UTC. */
	timeZone: Schema.optionalKey(Schema.String.check(isTimeZone)),
});
export type FamilyQuestion = typeof FamilyQuestion.Type;

/** A record the agent read for an answer. `stale` is true when the source time is over 24 hours old. */
export const Evidence = Schema.Struct({
	...HealthSample.fields,
	stale: Schema.Boolean,
});
export type Evidence = typeof Evidence.Type;

/** `POST /ask` reply. The server fills `evidence` and `unavailable` from the records, not the model. */
export const FamilyAnswer = Schema.Struct({
	answer: Schema.NonEmptyString,
	/** Every record the agent read, with source and freshness. Empty when it found none. */
	evidence: Schema.Array(Evidence),
	/** Metrics the agent looked for that have no records. */
	unavailable: Schema.Array(Schema.String),
	model: Schema.String,
	answeredAt: Schema.String,
});
export type FamilyAnswer = typeof FamilyAnswer.Type;
