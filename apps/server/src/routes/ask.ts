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
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FamilyDb } from "../db";
import { delegate } from "../delegation";
import { familyTools } from "../family-tools";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import { maxAudioBytes, type Voice } from "../integrations/elevenlabs";
import type { FetchAgentConfig } from "../integrations/fetch";
import type { GeminiConfig } from "../integrations/gemini";
import { askGemini } from "../integrations/gemini-chat";
import { listFact, readCareFacts } from "./care-profile";

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
	"Repeat names, routines, trips, plans, and earlier requests only when the saved facts below or your tools gave them. When something is not saved, say kindly that you do not have it saved and suggest asking a family member. Never invent or guess a memory.",
	"When they tell you how they feel, say back the feeling in their own words, then offer to keep talking or to call a family member or friend. Do not call a feeling anxiety unless they did, and do not promise that everything is fine.",
	"When they feel lonely or miss someone, you may suggest a call to a family member or friend.",
	"If they ask for urgent help or describe a serious symptom, tell them only to call their emergency number or a family member now.",
	"Use short, simple sentences. Give at most one next step.",
].join("\n");

/**
 * Saved facts the wearer may hear again. The #26 profile only when the caller holds
 * `health_records`, as everywhere else; the latest trip plan and the caller's own requests are
 * already readable by every member.
 */
const wearerFacts = (c: Context<FamilyEnv>): string[] => {
	const { db, familyId } = c.var;
	const profile = readCareFacts(c)?.profile;
	const lines =
		profile === undefined
			? []
			: [
					`Their preferred name: ${profile.preferredName ?? "not saved"}.`,
					...(profile.language === null
						? []
						: [
								`Their preferred language: ${profile.language}. Answer in it unless they ask for another language.`,
							]),
					listFact(
						"Their routines",
						profile.routines?.map((r) =>
							r.time === null ? r.name : `${r.name} at ${r.time}`,
						) ?? null,
					),
					// Names and relationships only: phone numbers never go to the model.
					listFact(
						"Their people, in contact order",
						profile.contacts?.map((p) =>
							p.relationship === null
								? p.name
								: `${p.name} (${p.relationship})`,
						) ?? null,
					),
				];
	const trips = [...db.connection.db.myTripEvents.iter()]
		.filter((row) => row.familyId === familyId)
		.sort((a, b) => (a.id < b.id ? 1 : -1));
	const plan = trips.find(
		(row) => row.step.tag === "Leaving" && row.purpose !== undefined,
	);
	const latest = trips.find((row) => row.tripId === plan?.tripId);
	if (plan !== undefined && latest !== undefined)
		lines.push(
			`Their latest trip plan, stated ${plan.at.toISOString()}: ${plan.purpose}${plan.destination === undefined ? "" : `, to ${plan.destination}`}. Now: ${latest.step.tag.toLowerCase()}.`,
		);
	const requests = [...db.connection.db.myCareNeeds.iter()]
		.filter(
			(row) =>
				row.familyId === familyId &&
				row.kind.tag !== "Alert" &&
				row.raisedBy.toHexString() === db.identity,
		)
		.sort((a, b) => (a.id < b.id ? 1 : -1))
		.slice(0, 3);
	for (const row of requests)
		lines.push(
			`They asked their family, ${row.createdAt.toISOString()}: “${row.summary}”. Status: ${row.status.tag.toLowerCase()}.`,
		);
	return lines.length === 0 ? [] : ["Saved facts you may repeat:", ...lines];
};

/**
 * Answers one family question; the routes and the iMessage agent share it. `facts` gives the
 * saved facts a wearer may hear again; it is read only for a wearer's question. `db` is the asking
 * member's connection: without the Fetch.ai bridge, the tools read the records through it.
 */
export const familyAnswer =
	({ gemini, fetchAgent }: Pick<AskDeps, "gemini" | "fetchAgent">) =>
	(
		familyId: bigint,
		question: FamilyQuestion,
		facts: () => readonly string[] = () => [],
		db?: FamilyDb,
	) => {
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
		const source = fetchAgent ?? db;
		if (source === undefined)
			throw new ApiFailure(
				"unavailable",
				"Fetch.ai tool routing is not configured",
			);
		const answer = (delegation?: string) => {
			const family = familyTools(
				source,
				familyId,
				now,
				question.timeZone,
				delegation,
			);
			const rules =
				question.asker === "wearer"
					? [family.rules, wearerRules, ...facts()].join("\n")
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
		// Through Fetch.ai, the worker reads through the asker's connection for this family while the
		// question runs (`delegation.ts`), so it needs no standing access to any family.
		if (fetchAgent === undefined || db === undefined) return answer();
		return Effect.acquireUseRelease(
			Effect.sync(() => delegate(db, familyId)),
			({ token }) => answer(token),
			({ release }) => Effect.sync(release),
		);
	};

export const askRoutes = ({ gemini, fetchAgent, voice }: AskDeps) => {
	const askFamily = familyAnswer({ gemini, fetchAgent });
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
					askFamily(c.var.familyId, question, () => wearerFacts(c), c.var.db),
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
				const answer = await run(
					signal,
					askFamily(
						c.var.familyId,
						question.value,
						() => wearerFacts(c),
						c.var.db,
					),
				);
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
