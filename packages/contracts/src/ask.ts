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

// Effect's `isBase64` regex overflows the V8 stack on strings of a few MiB; this one is linear.
const isBase64 = Schema.makeFilter(
	(text: string) =>
		text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text),
);

/** Largest attached file, decoded. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Largest total of the attached files in one question, decoded. */
export const ATTACHMENTS_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** A file the asker attaches to one question. It goes to Gemini with the question and is not stored. */
export const QuestionAttachment = Schema.Struct({
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	mimeType: Schema.Literals([
		"image/png",
		"image/jpeg",
		"image/webp",
		"application/pdf",
		"text/plain",
	]),
	/** Base64 file bytes. The server accepts at most 5 MiB per file and 8 MiB in total, decoded. */
	data: Schema.String.check(Schema.isMinLength(1), isBase64),
});
export type QuestionAttachment = typeof QuestionAttachment.Type;

/** `POST /ask` body: a family member's question about the family's records. The wearer is a member too. */
export const FamilyQuestion = Schema.Struct({
	question: Schema.String.check(
		Schema.isPattern(/\S/),
		Schema.isMaxLength(2000),
	),
	/** IANA time zone for times in the answer, such as `Europe/Berlin`. Default UTC. */
	timeZone: Schema.optionalKey(Schema.String.check(isTimeZone)),
	/** At most 4 files. Gemini reads them with the question; the server does not store them. */
	attachments: Schema.optionalKey(
		Schema.Array(QuestionAttachment).check(Schema.isMaxLength(4)),
	),
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
	/** 0 to 3 short questions that Gemini made from this answer. Empty when Gemini gave none. */
	followUps: Schema.Array(Schema.String),
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
