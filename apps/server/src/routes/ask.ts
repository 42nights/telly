// Family questions, relative to `/api/families/:familyId` behind sign-in and the membership check.
// Gemini answers; its data tools run through Fetch.ai Agentverse; voice questions use ElevenLabs.
import {
	type FamilyAnswer,
	FamilyQuestion,
	type SpokenAnswer,
	type VoiceAnswer,
} from "@health/contracts/ask";
import { Cause, Effect, Exit, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { familyQuestion } from "../family-agent";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import { maxAudioBytes, type Voice } from "../integrations/elevenlabs";
import { callAgentTool, type FetchAgentConfig } from "../integrations/fetch";
import type { GeminiConfig } from "../integrations/gemini";
import { askGemini } from "../integrations/gemini-chat";

export type AskDeps = {
	/** Unset: questions answer `unavailable`. */
	readonly gemini: GeminiConfig | undefined;
	/** Unset: questions answer `unavailable`; the agent never reads records around Fetch.ai. */
	readonly fetchAgent: FetchAgentConfig | undefined;
	readonly voice: Voice;
};

type ProviderError = {
	readonly reason: "unavailable" | "upstream_error";
	readonly message: string;
};

/** Runs a provider effect for this request; a client disconnect interrupts it and aborts the call. */
const run = async <A>(
	signal: AbortSignal,
	effect: Effect.Effect<A, ProviderError | ApiFailure>,
): Promise<A | undefined> => {
	const exit = await Effect.runPromiseExit(
		Effect.mapError(effect, (error) =>
			error instanceof ApiFailure
				? error
				: new ApiFailure(error.reason, error.message),
		),
		{ signal },
	);
	if (Exit.isSuccess(exit)) return exit.value;
	if (Cause.hasInterruptsOnly(exit.cause)) return undefined;
	throw Cause.squash(exit.cause);
};

// 499: the client disconnected, so nobody reads this response.
const gone = () => new Response(null, { status: 499 });

export const askRoutes = ({ gemini, fetchAgent, voice }: AskDeps) => {
	const ask = (familyId: bigint, question: FamilyQuestion) => {
		if (fetchAgent === undefined)
			throw new ApiFailure(
				"unavailable",
				"Fetch.ai tool routing is not configured",
			);
		const agent = familyQuestion(
			(id, request) =>
				Effect.tryPromise({
					try: (signal) => callAgentTool(fetchAgent, id, request, signal),
					catch: (error) =>
						error instanceof ApiFailure
							? error
							: new ApiFailure("upstream_error", "The agent tool failed"),
				}),
			familyId,
			question,
			new Date(),
		);
		return askGemini(gemini, { ...agent, question: question.question }).pipe(
			Effect.map(({ text, model }) => agent.answer(text, model)),
		);
	};
	return new Hono<FamilyEnv>()
		.post("/ask", async (c) => {
			const question = await decodeBody(c, FamilyQuestion);
			const answer = await run(c.req.raw.signal, ask(c.var.familyId, question));
			if (answer === undefined) return gone();
			c.header("cache-control", "no-store");
			return c.json(answer satisfies FamilyAnswer);
		})
		.post(
			"/ask/voice",
			bodyLimit({
				maxSize: maxAudioBytes,
				onError: () => {
					throw new ApiFailure(
						"invalid_request",
						"The recording (10 MiB at most) is too large",
					);
				},
			}),
			async (c) => {
				if (!c.req.header("content-type")?.startsWith("audio/"))
					throw new ApiFailure(
						"invalid_request",
						"Send the recording with an audio/* Content-Type",
					);
				const timeZone = c.req.query("timeZone");
				const audio = await c.req.blob();
				if (audio.size === 0)
					throw new ApiFailure("invalid_request", "The recording is empty");
				const { signal } = c.req.raw;
				const transcript = await run(signal, voice.transcribe(audio));
				if (transcript === undefined) return gone();
				const question = Schema.decodeUnknownOption(FamilyQuestion)({
					question: transcript.text,
					...(timeZone === undefined ? {} : { timeZone }),
				});
				if (question._tag === "None")
					throw new ApiFailure(
						"invalid_request",
						"No question was recognized, or timeZone is not valid",
					);
				const answer = await run(signal, ask(c.var.familyId, question.value));
				if (answer === undefined) return gone();
				// The text answer stands when speech fails; the reason stays explicit.
				const speech = await run(
					signal,
					voice
						.synthesize({
							text: answer.answer,
							languageCode: transcript.languageCode,
						})
						.pipe(
							Effect.map(
								(mp3): SpokenAnswer => ({
									status: "ok",
									languageCode: transcript.languageCode,
									audio: Buffer.from(mp3).toString("base64"),
								}),
							),
							Effect.catch(({ reason, message }) =>
								Effect.succeed<SpokenAnswer>({ status: reason, message }),
							),
						),
				);
				if (speech === undefined) return gone();
				c.header("cache-control", "no-store");
				return c.json({ transcript, answer, speech } satisfies VoiceAnswer);
			},
		);
};
