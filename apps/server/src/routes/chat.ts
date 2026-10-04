// Family chat routes, relative to `/api/families/:familyId`, behind the API core's sign-in and
// family membership check. Messages persist in the family database; questions go to the Grokbot
// agent, whose data tools run through Fetch.ai; voice questions use the ElevenLabs adapter.
import {
	type FamilyAnswer,
	type FamilyMessages,
	FamilyQuestion,
	SendFamilyMessage,
	type SpokenAnswer,
	type VoiceAnswer,
} from "@health/contracts/chat";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readFamilyRecords } from "../db";
import { type AgentToolCaller, answerQuestion } from "../family-agent";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import { maxAudioBytes, type Voice } from "../integrations/elevenlabs";
import type { GrokbotConfig } from "../integrations/grokbot";

export type ChatDeps = {
	/** Unset: questions answer `unavailable`. */
	readonly grokbot: GrokbotConfig | undefined;
	/** Unset: questions answer `unavailable`; the agent never reads records around Fetch.ai. */
	readonly callTool: AgentToolCaller | undefined;
	readonly voice: Voice;
};

const PAGE = 200;

/**
 * Runs a provider effect for this request; a client disconnect interrupts it. A provider failure
 * becomes its typed `ApiError`; interruption and defects go to the generic 500 handler.
 */
const run = async <A>(
	effect: Effect.Effect<
		A,
		{ readonly reason: string; readonly message?: string }
	>,
	signal: AbortSignal,
) => {
	const exit = await Effect.runPromiseExit(effect, { signal });
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.findErrorOption(exit.cause);
	if (Option.isNone(failure)) throw Cause.squash(exit.cause);
	const { reason, message } = failure.value;
	console.error(`chat provider failed: ${reason}`);
	throw new ApiFailure(
		reason === "unavailable" ? "unavailable" : "upstream_error",
		message ?? `The Grokbot agent did not answer (${reason})`,
	);
};

export const chatRoutes = ({ grokbot, callTool, voice }: ChatDeps) => {
	const ask = (familyId: bigint, question: FamilyQuestion) => {
		if (grokbot === undefined)
			throw new ApiFailure(
				"unavailable",
				"Grokbot is not configured (XAI_API_KEY)",
			);
		if (callTool === undefined)
			throw new ApiFailure(
				"unavailable",
				"Fetch.ai tool routing is not configured",
			);
		return answerQuestion(grokbot, callTool, familyId, question, new Date());
	};
	return new Hono<FamilyEnv>()
		.get("/messages", (c) => {
			const after = c.req.query("after") ?? "0";
			if (!/^\d+$/.test(after))
				throw new ApiFailure("invalid_request", "after must be a message id");
			const familyId = c.var.familyId.toString();
			const messages = readFamilyRecords(c.var.db)
				.messages.filter(
					(m) => m.familyId === familyId && BigInt(m.id) > BigInt(after),
				)
				.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
				.slice(0, PAGE);
			return c.json({ messages } satisfies FamilyMessages);
		})
		.post("/messages", async (c) => {
			const message = await decodeBody(c, SendFamilyMessage);
			const { db, familyId } = c.var;
			await callReducer(
				db.connection.reducers.sendMessage({ familyId, ...message }),
			);
			const stored = readFamilyRecords(db).messages.find(
				(m) =>
					m.familyId === familyId.toString() &&
					m.sender === db.identity &&
					m.clientId === message.clientId,
			);
			if (stored === undefined)
				throw new Error("the sent message is not visible to its sender");
			return c.json(stored, 201);
		})
		.post("/ask", async (c) => {
			const question = await decodeBody(c, FamilyQuestion);
			const answer = await run(ask(c.var.familyId, question), c.req.raw.signal);
			return c.json(answer satisfies FamilyAnswer);
		})
		.post(
			"/ask/voice",
			bodyLimit({
				maxSize: maxAudioBytes,
				onError: () => {
					throw new ApiFailure(
						"invalid_request",
						"Audio is larger than 10 MiB",
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
				const transcript = await run(voice.transcribe(audio), signal);
				const question = Schema.decodeUnknownOption(FamilyQuestion)({
					question: transcript.text,
					...(timeZone === undefined ? {} : { timeZone }),
				});
				if (Option.isNone(question))
					throw new ApiFailure(
						"invalid_request",
						"No question was recognized, or timeZone is not valid",
					);
				const answer = await run(ask(c.var.familyId, question.value), signal);
				// The text answer stands when speech fails; the reason stays explicit.
				const spoken = await Effect.runPromiseExit(
					voice.synthesize({
						text: answer.answer,
						languageCode: transcript.languageCode,
					}),
					{ signal },
				);
				let speech: SpokenAnswer;
				if (Exit.isSuccess(spoken)) {
					speech = {
						status: "ok",
						languageCode: transcript.languageCode,
						audio: Buffer.from(spoken.value).toString("base64"),
					};
				} else {
					const failure = Cause.findErrorOption(spoken.cause);
					if (Option.isNone(failure)) throw Cause.squash(spoken.cause);
					speech = {
						status: failure.value.reason,
						message: failure.value.message,
					};
				}
				return c.json({ transcript, answer, speech } satisfies VoiceAnswer);
			},
		);
};
