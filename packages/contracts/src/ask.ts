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
	/** `wearer`: the person with memory loss asks from the wearer screen, so the answer uses the calm-support rules. */
	asker: Schema.optionalKey(Schema.Literal("wearer")),
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
	/**
	 * True when the question asked for urgent help or reported a serious symptom (`urgentRequest`).
	 * The server then asks no model, reads no records, and `model` is `none`: open the help flow.
	 */
	urgent: Schema.Boolean,
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

// Words of an explicit help request or a serious symptom, matched in lower case without accents.
// ponytail: English and Spanish word lists; add a language's list when the app supports it. A
// match is never a diagnosis: it only opens the help flow, and the wearer can go back.
const URGENT: Readonly<Record<"en" | "es", ReadonlyArray<RegExp>>> = {
	en: [
		/^\W*(please\W+)?help(\W+me)?(\W+please)?\W*$/,
		/\bneed help\W*(now|right now|quickly|fast)?\W*$/,
		/\b(call|get|send)\b.{0,20}\b(911|112|999|ambulance|paramedics?|police|emergency|a doctor)\b/,
		/\bemergency\b|\bambulance\b/,
		/\bfell\b(?!\s+asleep)|\bfallen\b|\bfall(ing)? down\b|\bcan'?t get up\b|\bcannot get up\b/,
		/\bchest\b.{0,20}\b(pain|hurts?|pressure|tight\w*)\b|\b(pain|pressure)\b.{0,15}\bchest\b/,
		/\b(can'?t|cannot|can not|hard to|trouble|struggling to|difficulty)\s+breath(e|ing)?\b|\bshort(ness)? of breath\b|\bnot breathing\b/,
		/\bbleed(ing|s)?\b|\bhit my head\b|\bsevere pain\b/,
		/\bfaint(ed|ing)?\b|\bpass(ed|ing)? out\b|\bunconscious\b|\bunresponsive\b|\bwon'?t wake up\b/,
		/\bstroke\b|\bface\b.{0,10}\bdroop|\bslurr|\bnumb(ness)?\b|\bheart attack\b|\bseizure\b|\bchok(e|ing)\b/,
		/\boverdose\b|\btoo many (pills|tablets|meds|medicines?)\b|\bsuicid|\bkill myself\b|\bend my life\b|\bwant to die\b/,
	],
	es: [
		/^\W*(por favor\W+)?ayuda(me)?(\W+por favor)?\W*$|\bnecesito ayuda\W*$|\bsocorro\b/,
		/\bemergencias?\b|\bambulancia\b|\bllam[ae]\w*\b.{0,20}\b(911|112|policia|medico)\b/,
		/\bme (he )?caido\b|\bme cai\b|\bno (me )?puedo levantar(me)?\b/,
		/\b(dolor|duele)\b.{0,15}\bpecho\b|\bpecho\b.{0,15}\bduele\b|\bno puedo respirar\b|\bme falta (el )?aire\b|\bme ahogo\b/,
		/\bsangr(o|ando|e)\b|\bdesmay|\binfarto\b|\bderrame\b|\bconvulsi/,
		/\bsobredosis\b|\bquiero morir(me)?\b|\bsuicid/,
	],
};

/**
 * The language of an explicit help request or a serious symptom in `text`, or null. Clients check
 * it before any other route, and the server answers such a question `urgent` without a model, so
 * a calm conversation never delays the help flow.
 */
export const urgentRequest = (text: string): "en" | "es" | null => {
	const plain = text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replaceAll("’", "'")
		.toLowerCase();
	if (URGENT.en.some((words) => words.test(plain))) return "en";
	if (URGENT.es.some((words) => words.test(plain))) return "es";
	return null;
};
