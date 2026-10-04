// Family questions answered by Gemini, under `/api/families/:familyId`. Voice uses ElevenLabs.
import { Schema } from "effect";
import { CitedRecords } from "./chat";
import { LanguageCode, VoiceTranscript } from "./voice";

const isTimeZone = Schema.makeFilter((zone: string) => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
});

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

/**
 * `POST /ask` reply. `evidence`, `alerts`, and `unavailable` are the family tools' `CitedRecords`:
 * the server fills them from the records the Fetch.ai tool calls returned, not from the model's text.
 */
export const FamilyAnswer = Schema.Struct({
	answer: Schema.NonEmptyString,
	...CitedRecords.fields,
	/** The Gemini model that answered. */
	model: Schema.String,
	answeredAt: Schema.String,
});
export type FamilyAnswer = typeof FamilyAnswer.Type;

/** Spoken reply: MP3 in the language of the question, or why there is none. The text answer stands either way. */
export const SpokenAnswer = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ok"),
		languageCode: LanguageCode,
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
