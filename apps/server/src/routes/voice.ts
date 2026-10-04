import {
	LanguageCode,
	SpeechRequest,
	type VoiceTranscript,
} from "@health/contracts/voice";
import { Cause, Effect, Exit, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiFailure, decodeBody, type FamilyEnv, typedFailure } from "../http";
import {
	maxAudioBytes,
	type Voice,
	type VoiceError,
} from "../integrations/elevenlabs";

/**
 * Runs a provider effect for one request. A client disconnect interrupts it and aborts the provider
 * call. Audio stays in memory for this request only and is never logged or stored.
 */
const run = async <A>(
	signal: AbortSignal,
	effect: Effect.Effect<A, VoiceError>,
): Promise<A | undefined> => {
	const exit = await Effect.runPromiseExit(effect, { signal });
	if (Exit.isSuccess(exit)) return exit.value;
	if (Cause.hasInterruptsOnly(exit.cause)) return undefined;
	const { reason, message } = typedFailure(exit.cause);
	throw new ApiFailure(reason, message);
};

// 499: the client disconnected, so nobody reads this response.
const disconnected = () => new Response(null, { status: 499 });

const tooLarge = (what: string) => () => {
	throw new ApiFailure("invalid_request", `${what} is too large`);
};

/** Voice routes, relative to `/api/families/:familyId` behind the membership check. */
export const voiceRoutes = (voice: Voice) =>
	new Hono<FamilyEnv>()
		.post(
			"/voice/transcriptions",
			bodyLimit({
				maxSize: maxAudioBytes,
				onError: tooLarge("The recording (10 MiB at most)"),
			}),
			async (c) => {
				if (!c.req.header("content-type")?.startsWith("audio/"))
					throw new ApiFailure(
						"invalid_request",
						"Send the recording with an audio/* Content-Type",
					);
				const hint = c.req.query("languageCode");
				if (hint !== undefined && !Schema.is(LanguageCode)(hint))
					throw new ApiFailure(
						"invalid_request",
						"languageCode must be an ISO 639 code",
					);
				const audio = await c.req.blob();
				if (audio.size === 0)
					throw new ApiFailure("invalid_request", "The recording is empty");
				const transcript = await run(
					c.req.raw.signal,
					voice.transcribe(audio, hint),
				);
				if (transcript === undefined) return disconnected();
				return c.json(transcript satisfies VoiceTranscript);
			},
		)
		.post(
			"/voice/speech",
			bodyLimit({ maxSize: 16 * 1024, onError: tooLarge("The request") }),
			async (c) => {
				const request = await decodeBody(c, SpeechRequest);
				const audio = await run(c.req.raw.signal, voice.synthesize(request));
				if (audio === undefined) return disconnected();
				return c.body(audio, 200, {
					"content-type": "audio/mpeg",
					"cache-control": "no-store",
				});
			},
		);
