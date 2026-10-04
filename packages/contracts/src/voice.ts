import { Schema } from "effect";

/** Spoken language: ISO 639-1 where one exists ("en", "es"), otherwise ISO 639-3 ("fil"). */
export const LanguageCode = Schema.String.check(
	Schema.isPattern(/^[a-z]{2,3}$/),
);
export type LanguageCode = typeof LanguageCode.Type;

/**
 * `POST /api/families/:familyId/voice/transcriptions` reply. The request body is the raw recording
 * with an `audio/*` Content-Type (at most 10 MiB); `?languageCode=` is an optional hint.
 */
export const VoiceTranscript = Schema.Struct({
	text: Schema.String,
	/** The language the provider detected, or the hint when one was sent. */
	languageCode: LanguageCode,
	/** Provider confidence in `languageCode`, from 0 to 1. */
	languageProbability: Schema.Number.check(
		Schema.isBetween({ minimum: 0, maximum: 1 }),
	),
});
export type VoiceTranscript = typeof VoiceTranscript.Type;

/**
 * `POST /api/families/:familyId/voice/speech` body. The reply is `audio/mpeg`, or an `ApiError`.
 * Without `languageCode`, the provider infers the language from the text.
 */
export const SpeechRequest = Schema.Struct({
	text: Schema.String.check(Schema.isMaxLength(2000), Schema.isPattern(/\S/)),
	languageCode: Schema.optionalKey(LanguageCode),
});
export type SpeechRequest = typeof SpeechRequest.Type;
