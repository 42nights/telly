// Family chat: family messages and questions to the Grokbot agent, under `/api/families/:familyId`.
import { Schema } from "effect";
import { Alert, FamilyMessage, HealthSample, VoiceTranscript } from "./index";

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

/** `POST /ask` body: a family member's question about the family's records. The wearer is a member too. */
export const FamilyQuestion = Schema.Struct({
	question: Schema.String.check(
		Schema.isPattern(/\S/),
		Schema.isMaxLength(2000),
	),
	/** IANA time zone for times in the answer, such as `Europe/Berlin`. Default UTC. */
	timeZone: Schema.optionalKey(Schema.String.check(isTimeZone)),
});
export type FamilyQuestion = typeof FamilyQuestion.Type;

/** A sample the agent read for an answer. `stale` is true when the source time is over 24 hours old. */
export const Evidence = Schema.Struct({
	...HealthSample.fields,
	stale: Schema.Boolean,
});
export type Evidence = typeof Evidence.Type;

/**
 * `POST /ask` reply. The server fills `evidence`, `alerts`, and `unavailable` from the records that
 * the agent's Fetch.ai tool calls returned, not from the model's text.
 */
export const FamilyAnswer = Schema.Struct({
	answer: Schema.NonEmptyString,
	/** Every sample the agent read, with source and freshness. Empty when it found none. */
	evidence: Schema.Array(Evidence),
	/** Every alert the agent read. */
	alerts: Schema.Array(Alert),
	/** What the agent looked for and found no records of: a metric, or `health_samples` for any metric. */
	unavailable: Schema.Array(Schema.String),
	model: Schema.String,
	answeredAt: Schema.String,
});
export type FamilyAnswer = typeof FamilyAnswer.Type;

/** Spoken reply: MP3 in the language of the question, or why there is none. The text answer stands either way. */
export const SpokenAnswer = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ok"),
		languageCode: Schema.String,
		/** Base64 MP3. */
		audio: Schema.String,
	}),
	Schema.Struct({
		status: Schema.Literals(["unavailable", "upstream_error"]),
		message: Schema.String,
	}),
]);
export type SpokenAnswer = typeof SpokenAnswer.Type;

/**
 * `POST /ask/voice` reply. The body is the raw recording (`audio/*`, at most 10 MiB); `?timeZone=`
 * is optional.
 */
export const VoiceAnswer = Schema.Struct({
	transcript: VoiceTranscript,
	answer: FamilyAnswer,
	speech: SpokenAnswer,
});
export type VoiceAnswer = typeof VoiceAnswer.Type;
