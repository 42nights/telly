// Family questions, relative to `/api/families/:familyId` behind sign-in and the membership check.
// Gemini answers; its data tools run through Fetch.ai Agentverse; voice questions use ElevenLabs.
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENTS_MAX_TOTAL_BYTES,
	type FamilyAnswer,
	FamilyQuestion,
	type SpokenAnswer,
	urgentRequest,
	type VoiceAnswer,
} from "@health/contracts/ask";
import { Cause, Effect, Exit, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { familyTools } from "../family-tools";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import { maxAudioBytes, type Voice } from "../integrations/elevenlabs";
import type { FetchAgentConfig } from "../integrations/fetch";
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

// Base64 grows 4/3 (rounded up per file, at most 4 files); the rest is the question and file names.
const maxQuestionBodyBytes =
	Math.ceil(ATTACHMENTS_MAX_TOTAL_BYTES / 3) * 4 + 4 * 4 + 64 * 1024;

/** Checks the decoded file sizes. Messages name the file by its position, never by its content. */
const checkAttachments = ({ attachments = [] }: FamilyQuestion) => {
	let total = 0;
	for (const [index, { data }] of attachments.entries()) {
		const bytes = Buffer.byteLength(data, "base64");
		if (bytes > ATTACHMENT_MAX_BYTES)
			throw new ApiFailure(
				"invalid_request",
				`File ${index + 1} is larger than 5 MiB`,
			);
		total += bytes;
	}
	if (total > ATTACHMENTS_MAX_TOTAL_BYTES)
		throw new ApiFailure(
			"invalid_request",
			"The files are larger than 8 MiB in total",
		);
};

/** The reply to an urgent request, in the language of its words. No model writes it. */
const urgentAnswer = {
	en: "This sounds urgent. Call your emergency number or a family member now.",
	es: "Esto parece urgente. Llame ahora a su número de emergencia o a un familiar.",
} as const;

/** Calm-support rules for the person with memory loss, added to the family tools' rules. */
const wearerRules = [
	"You are talking with the person with memory loss. You are an assistant, not a relative or a friend. Never pretend to be a family member, and say that you are an assistant when asked.",
	"They may ask the same thing again. Answer again patiently, the same way. Never say that they asked before, never test their memory, and never correct, embarrass, or argue with them.",
	"Repeat names, routines, trips, plans, and earlier requests only when your tools returned them. When something is not saved, say kindly that you do not have it saved and suggest asking a family member. Never invent or guess a memory.",
	"When they tell you how they feel, say back the feeling in their own words, then offer to keep talking or to call a family member or friend. Do not call a feeling anxiety unless they did, and do not promise that everything is fine.",
	"When they feel lonely or miss someone, you may suggest a call to a family member or friend.",
	"If they ask for urgent help or describe a serious symptom, tell them only to call their emergency number or a family member now.",
	"Use short, simple sentences. Give at most one next step.",
].join("\n");

export const askRoutes = ({ gemini, fetchAgent, voice }: AskDeps) => {
	const ask = (familyId: bigint, question: FamilyQuestion) => {
		const now = new Date();
		// Checked before any provider, so help never waits on a model or a missing configuration.
		const urgent = urgentRequest(question.question);
		if (urgent !== null)
			return Effect.succeed<FamilyAnswer>({
				answer: urgentAnswer[urgent],
				evidence: [],
				alerts: [],
				unavailable: [],
				model: "none",
				answeredAt: now.toISOString(),
				followUps: [],
				urgent: true,
			});
		// Checked first, so Gemini never runs a question whose tools cannot read records.
		if (fetchAgent === undefined)
			throw new ApiFailure(
				"unavailable",
				"Fetch.ai tool routing is not configured",
			);
		const family = familyTools(fetchAgent, familyId, now, question.timeZone);
		const rules =
			question.asker === "wearer"
				? `${family.rules}\n${wearerRules}`
				: family.rules;
		return askGemini(gemini, question, { ...family, rules }).pipe(
			Effect.map(
				({ text, model, followUps }): FamilyAnswer => ({
					answer: text,
					...family.cited(),
					model,
					answeredAt: now.toISOString(),
					followUps,
					urgent: false,
				}),
			),
		);
	};
	return new Hono<FamilyEnv>()
		.post(
			"/ask",
			bodyLimit({
				maxSize: maxQuestionBodyBytes,
				onError: () => {
					throw new ApiFailure(
						"invalid_request",
						"The question and its files are too large (8 MiB of files at most)",
					);
				},
			}),
			async (c) => {
				const question = await decodeBody(c, FamilyQuestion);
				checkAttachments(question);
				const answer = await run(
					c.req.raw.signal,
					ask(c.var.familyId, question),
				);
				if (answer === undefined) return gone();
				c.header("cache-control", "no-store");
				return c.json(answer satisfies FamilyAnswer);
			},
		)
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
				const asker = c.req.query("asker");
				const audio = await c.req.blob();
				if (audio.size === 0)
					throw new ApiFailure("invalid_request", "The recording is empty");
				const { signal } = c.req.raw;
				const transcript = await run(signal, voice.transcribe(audio));
				if (transcript === undefined) return gone();
				const question = Schema.decodeUnknownOption(FamilyQuestion)({
					question: transcript.text,
					...(timeZone === undefined ? {} : { timeZone }),
					...(asker === undefined ? {} : { asker }),
				});
				if (question._tag === "None")
					throw new ApiFailure(
						"invalid_request",
						"No question was recognized, or timeZone or asker is not valid",
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
