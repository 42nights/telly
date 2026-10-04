import {
	type ApiError,
	LanguageCode,
	SpeechRequest,
	type VoiceTranscript,
} from "@health/contracts";
import { Cause, Effect, Exit, Schema } from "effect";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	maxAudioBytes,
	type Voice,
	type VoiceError,
} from "../integrations/elevenlabs";

const invalid = (c: Context, message: string, status: 400 | 413 | 415 = 400) =>
	c.json({ error: "invalid_request", message } satisfies ApiError, status);

/**
 * Runs a provider effect for one request. A client disconnect interrupts it and aborts the provider
 * call. Audio stays in memory for this request only and is never logged or stored.
 */
const respond = async <A>(
	c: Context,
	effect: Effect.Effect<A, VoiceError>,
	ok: (value: A) => Response,
) => {
	const exit = await Effect.runPromiseExit(effect, {
		signal: c.req.raw.signal,
	});
	if (Exit.isSuccess(exit)) return ok(exit.value);
	// 499: the client disconnected, so nobody reads this response.
	if (Cause.hasInterruptsOnly(exit.cause))
		return new Response(null, { status: 499 });
	const failure = Cause.findErrorOption(exit.cause);
	if (failure._tag === "None") throw Cause.squash(exit.cause);
	const { reason, message } = failure.value;
	return c.json(
		{ error: reason, message } satisfies ApiError,
		reason === "unavailable" ? 503 : 502,
	);
};

/** Voice routes, relative to the authenticated family prefix `/api/families/:familyId`. */
export const voiceRoutes = (voice: Voice) =>
	new Hono()
		.post(
			"/voice/transcriptions",
			bodyLimit({
				maxSize: maxAudioBytes,
				onError: (c) => invalid(c, "Audio is larger than 10 MiB", 413),
			}),
			async (c) => {
				if (!c.req.header("content-type")?.startsWith("audio/"))
					return invalid(
						c,
						"Send the recording with an audio/* Content-Type",
						415,
					);
				const hint = c.req.query("languageCode");
				if (hint !== undefined && !Schema.is(LanguageCode)(hint))
					return invalid(c, "languageCode must be an ISO 639 code");
				const audio = await c.req.blob();
				if (audio.size === 0) return invalid(c, "The recording is empty");
				return respond(c, voice.transcribe(audio, hint), (transcript) =>
					c.json(transcript satisfies VoiceTranscript),
				);
			},
		)
		.post(
			"/voice/speech",
			bodyLimit({
				maxSize: 16 * 1024,
				onError: (c) => invalid(c, "The request is too large", 413),
			}),
			async (c) => {
				const request = Schema.decodeUnknownOption(SpeechRequest)(
					await c.req.json().catch(() => undefined),
				);
				if (request._tag === "None")
					return invalid(
						c,
						"Send { text, languageCode? } with 1 to 2000 characters of text",
					);
				return respond(c, voice.synthesize(request.value), (audio) =>
					c.body(audio, 200, {
						"content-type": "audio/mpeg",
						"cache-control": "no-store",
					}),
				);
			},
		);
