import {
	type LanguageCode,
	type SpeechRequest,
	VoiceTranscript,
} from "@health/contracts";
import { Data, Effect, Schema } from "effect";

/** Largest recording the server accepts, and largest speech it accepts back from the provider. */
export const maxAudioBytes = 10 * 1024 * 1024;
const maxTranscriptBytes = 1024 * 1024;
const timeoutMs = 30_000;
const transcriptionModel = "scribe_v2";
// Flash v2.5 enforces `language_code`; Multilingual v2 does not accept it.
const speechModel = "eleven_flash_v2_5";

export type ElevenLabsConfig = {
	/** Unset means the provider is unavailable. There is no silent or recorded fallback. */
	readonly apiKey: string | undefined;
	readonly voiceId: string;
	/** For isolated protocol servers only. Defaults to `https://api.elevenlabs.io`. */
	readonly baseUrl?: string;
};

/** Messages carry only the operation and HTTP status: never provider bodies, keys, or audio. */
export class VoiceError extends Data.TaggedError("VoiceError")<{
	readonly reason: "unavailable" | "upstream_error";
	readonly message: string;
}> {}

/** Voice provider for routes and for family request orchestration. */
export type Voice = {
	/** Transcribes one recording. `languageCode` is an optional hint. */
	readonly transcribe: (
		audio: Blob,
		languageCode?: LanguageCode,
	) => Effect.Effect<VoiceTranscript, VoiceError>;
	/** Speaks the text as MP3, in `languageCode` or, without one, the language of the text. */
	readonly synthesize: (
		request: SpeechRequest,
	) => Effect.Effect<Uint8Array<ArrayBuffer>, VoiceError>;
};

// Scribe can report ISO 639-3. The contract and the speech model use ISO 639-1 where one exists.
// ponytail: covers the speech model's languages only; other codes pass through as ISO 639-3.
const iso6391: Readonly<Record<string, string>> = {
	ara: "ar",
	bul: "bg",
	ces: "cs",
	cmn: "zh",
	dan: "da",
	deu: "de",
	ell: "el",
	eng: "en",
	fin: "fi",
	fra: "fr",
	hin: "hi",
	hrv: "hr",
	hun: "hu",
	ind: "id",
	ita: "it",
	jpn: "ja",
	kor: "ko",
	msa: "ms",
	nld: "nl",
	nor: "no",
	pol: "pl",
	por: "pt",
	ron: "ro",
	rus: "ru",
	slk: "sk",
	spa: "es",
	swe: "sv",
	tam: "ta",
	tur: "tr",
	ukr: "uk",
	vie: "vi",
	zho: "zh",
};

const ProviderTranscript = Schema.Struct({
	text: Schema.String,
	language_code: Schema.String,
	language_probability: Schema.Number,
});

const upstream = (message: string) =>
	new VoiceError({ reason: "upstream_error", message });

const readBounded = async (response: Response, limit: number) => {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of response.body ?? []) {
		size += chunk.byteLength;
		if (size > limit)
			throw upstream(`ElevenLabs sent more than ${limit} bytes`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
};

/**
 * One provider request. Interrupting the effect (client disconnect) aborts it, and it fails after
 * 30 s. Not retried: each call is billed and has no idempotency key.
 */
const call = <A>(
	config: ElevenLabsConfig & { readonly apiKey: string },
	operation: string,
	path: string,
	init: RequestInit,
	limit: number,
	parse: (body: Uint8Array<ArrayBuffer>, contentType: string) => A,
) =>
	Effect.tryPromise({
		try: async (signal) => {
			const response = await fetch(
				new URL(path, config.baseUrl ?? "https://api.elevenlabs.io"),
				{
					...init,
					headers: { ...init.headers, "xi-api-key": config.apiKey },
					signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
				},
			);
			if (!response.ok) {
				await response.body?.cancel();
				throw upstream(
					`ElevenLabs ${operation} failed with HTTP ${response.status}`,
				);
			}
			const body = await readBounded(response, limit);
			try {
				return parse(body, response.headers.get("content-type") ?? "");
			} catch {
				throw upstream(`ElevenLabs sent an invalid ${operation} response`);
			}
		},
		catch: (cause) =>
			cause instanceof VoiceError
				? cause
				: upstream(
						cause instanceof DOMException && cause.name === "TimeoutError"
							? `ElevenLabs ${operation} timed out after ${timeoutMs / 1000} s`
							: `ElevenLabs ${operation} could not be reached`,
					),
	});

const parseTranscript = (body: Uint8Array) => {
	const reply = Schema.decodeUnknownSync(ProviderTranscript)(
		JSON.parse(new TextDecoder().decode(body)),
	);
	const code = reply.language_code.toLowerCase();
	return Schema.decodeUnknownSync(VoiceTranscript)({
		text: reply.text,
		languageCode: iso6391[code] ?? code,
		languageProbability: reply.language_probability,
	});
};

const parseSpeech = (body: Uint8Array<ArrayBuffer>, contentType: string) => {
	if (!contentType.startsWith("audio/mpeg") || body.byteLength === 0)
		throw new Error("not MP3 audio");
	return body;
};

/** ElevenLabs speech-to-text and text-to-speech. Fails with `unavailable` when no key is set. */
export const elevenLabsVoice = (config: ElevenLabsConfig): Voice => {
	const { apiKey } = config;
	if (!apiKey) {
		const unavailable = Effect.fail(
			new VoiceError({
				reason: "unavailable",
				message: "ElevenLabs is not configured (ELEVENLABS_API_KEY)",
			}),
		);
		return { transcribe: () => unavailable, synthesize: () => unavailable };
	}
	const configured = { ...config, apiKey };
	return {
		transcribe: (audio, languageCode) => {
			const form = new FormData();
			form.append("model_id", transcriptionModel);
			form.append("file", audio);
			form.append("timestamps_granularity", "none");
			if (languageCode !== undefined)
				form.append("language_code", languageCode);
			return call(
				configured,
				"transcription",
				"/v1/speech-to-text",
				{ method: "POST", body: form },
				maxTranscriptBytes,
				parseTranscript,
			);
		},
		synthesize: ({ text, languageCode }) =>
			call(
				configured,
				"speech",
				`/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=mp3_44100_128`,
				{
					method: "POST",
					headers: { "content-type": "application/json", accept: "audio/mpeg" },
					body: JSON.stringify({
						text,
						model_id: speechModel,
						language_code: languageCode,
					}),
				},
				maxAudioBytes,
				parseSpeech,
			),
	};
};
