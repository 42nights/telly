// Gemini chat with function calling through the Interactions API, stateless (`store: false`): the
// server sends the whole history each turn, so Google keeps no copy of the family's records.
// https://ai.google.dev/gemini-api/docs/function-calling (Stateless function calling)
// The final answer is structured output, so the follow-ups come in the same reply as the answer.
// https://ai.google.dev/gemini-api/docs/structured-output (Structured outputs with tools)
import type { FamilyQuestion, QuestionAttachment } from "@health/contracts/ask";
import { Data, Effect, Schema } from "effect";
import type { FamilyTools } from "../family-tools";
import { ApiFailure } from "../http";
import { type GeminiConfig, overloaded, postInteraction } from "./gemini";

/** Pinned so a provider alias change cannot silently change answers. */
const GEMINI_CHAT_MODEL = "gemini-3.8-flash";

const requestTimeoutMs = 30_000;
// One question, all rounds and retries together, ends within this. A voice question also waits
// for transcription and speech, and the whole request must answer before a phone gives up (60 s).
const answerBudgetMs = 45_000;
// Overloaded calls (429/503) are tried again on both models after each wait.
const overloadBackoffMs = [1_000, 3_000];
const busy = "The assistant is busy right now. Try again in a minute";
// Each round runs the tools the model called; the answer must come within this many rounds.
const maxRounds = 4;
const maxFollowUps = 3;
const maxFollowUpLength = 200;

// The model fills this on its last turn, after the tool calls.
const answerFormat = {
	type: "text",
	mime_type: "application/json",
	schema: {
		type: "object",
		properties: {
			answer: { type: "string", description: "The answer to the question." },
			follow_ups: {
				type: "array",
				maxItems: maxFollowUps,
				items: { type: "string" },
				description:
					"Up to 3 short questions that the asker can ask next, each based on this answer. Empty when no question fits.",
			},
		},
		required: ["answer", "follow_ups"],
	},
};
const FinalAnswer = Schema.fromJsonString(
	Schema.Struct({
		answer: Schema.String,
		follow_ups: Schema.optionalKey(Schema.Unknown),
	}),
);
const FollowUps = Schema.Array(Schema.String);

/** Messages name only the step that failed: never provider text, keys, or records. */
class GeminiChatError extends Data.TaggedError("GeminiChatError")<{
	readonly reason: "unavailable" | "upstream_error";
	readonly message: string;
}> {}

const upstream = (message: string) =>
	new GeminiChatError({ reason: "upstream_error", message });

// Only the fields this adapter reads. Steps go back to the provider exactly as received.
const Step = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("function_call"),
		id: Schema.String,
		name: Schema.String,
		arguments: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({
		type: Schema.Literal("model_output"),
		content: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					type: Schema.String,
					text: Schema.optionalKey(Schema.String),
				}),
			),
		),
	}),
	Schema.Struct({ type: Schema.String }),
]);
const Interaction = Schema.Struct({
	status: Schema.String,
	model: Schema.optionalKey(Schema.String),
	steps: Schema.Array(Schema.Unknown),
});

/** Decodes one interaction: the steps as received, the function calls, and the answer text. */
const parseReply = (json: unknown) => {
	const reply = Schema.decodeUnknownOption(Interaction)(json);
	if (reply._tag === "None") throw upstream("Gemini sent an invalid reply");
	const steps = reply.value.steps.map((raw) => {
		const step = Schema.decodeUnknownOption(Step)(raw);
		if (step._tag === "None") throw upstream("Gemini sent an invalid reply");
		return step.value;
	});
	return {
		status: reply.value.status,
		model: reply.value.model ?? GEMINI_CHAT_MODEL,
		raw: reply.value.steps,
		calls: steps.flatMap((step) =>
			step.type === "function_call" && "id" in step ? [step] : [],
		),
		text: steps
			.flatMap((step) => ("content" in step ? (step.content ?? []) : []))
			.map((part) => part.text ?? "")
			.join("")
			.trim(),
	};
};

/** Keeps up to 3 distinct trimmed questions of 1 to 200 characters. Any other shape gives none. */
const followUpsFrom = (value: unknown): string[] => {
	const items = Schema.decodeUnknownOption(FollowUps)(value);
	if (items._tag === "None") return [];
	const kept = items.value
		.map((item) => item.trim())
		.filter((item) => item !== "" && item.length <= maxFollowUpLength);
	return [...new Set(kept)].slice(0, maxFollowUps);
};

/** The answer must be valid; bad follow-ups never fail it, they only give an empty list. */
const finalAnswer = (text: string, model: string) => {
	const final = Schema.decodeUnknownOption(FinalAnswer)(text);
	if (final._tag === "None")
		return Effect.fail(upstream("Gemini sent an invalid answer"));
	const answer = final.value.answer.trim();
	if (answer === "")
		return Effect.fail(upstream("Gemini sent an empty answer"));
	return Effect.succeed({
		text: answer,
		model,
		followUps: followUpsFrom(final.value.follow_ups),
	});
};

// Inline content for this question only. The Interactions API takes PDFs as `document` and
// images as `image`; plain text goes as a text part, because `document` takes only PDF and CSV.
const attachmentContent = ({ name, mimeType, data }: QuestionAttachment) => {
	if (mimeType === "application/pdf")
		return { type: "document", mime_type: mimeType, data };
	if (mimeType === "text/plain")
		return {
			type: "text",
			text: `File "${name}":\n${Buffer.from(data, "base64").toString("utf8")}`,
		};
	return { type: "image", mime_type: mimeType, data };
};

/** One call, with its overload retries. Completed rounds stay in the history, so none is redone. */
const interact = (
	config: GeminiConfig,
	body: Readonly<Record<string, unknown>> & { readonly model: string },
	deadline: AbortSignal,
) =>
	Effect.tryPromise({
		try: async (signal) => {
			const { response } = await postInteraction(
				config,
				body,
				AbortSignal.any([
					signal,
					deadline,
					AbortSignal.timeout(requestTimeoutMs),
				]),
				{ backoffMs: config.overloadBackoffMs ?? overloadBackoffMs },
			);
			if (!response.ok) {
				await response.body?.cancel();
				throw upstream(
					overloaded(response.status)
						? `${busy} (Gemini HTTP ${response.status}).`
						: `Gemini chat failed with HTTP ${response.status}`,
				);
			}
			return parseReply(await response.json().catch(() => undefined));
		},
		catch: (cause) => {
			if (cause instanceof GeminiChatError) return cause;
			if (deadline.aborted)
				return upstream(
					`${busy} (no answer within ${answerBudgetMs / 1000} s).`,
				);
			return upstream(
				cause instanceof DOMException && cause.name === "TimeoutError"
					? `Gemini chat timed out after ${requestTimeoutMs / 1000} s`
					: "Gemini could not be reached",
			);
		},
	});

/**
 * Runs the calls together through the family tools and returns their `function_result` steps in
 * call order. A failed tool call stops the answer with its `ApiFailure` and interrupts the others;
 * the model never continues without data.
 */
const functionResults = (
	run: FamilyTools["run"],
	calls: ReadonlyArray<{ id: string; name: string; arguments?: unknown }>,
) =>
	Effect.forEach(
		calls,
		(call) =>
			Effect.tryPromise({
				try: (signal) => run(call.name, call.arguments ?? {}, signal),
				catch: (error) =>
					error instanceof ApiFailure
						? error
						: new ApiFailure("upstream_error", "A family tool failed"),
			}).pipe(
				Effect.map((result) => ({
					type: "function_result",
					name: call.name,
					call_id: call.id,
					result: [{ type: "text", text: JSON.stringify(result) }],
				})),
			),
		// The calls of one round are independent reads, and each Fetch.ai round trip takes seconds.
		{ concurrency: "unbounded" },
	);

/**
 * Asks Gemini one question, with its attached files, and runs the tools it calls until it answers.
 * Fails when the reply is empty, invalid, incomplete, or still calling tools after the round limit;
 * it never makes up an answer or follow-ups. Interrupting it aborts the provider call.
 */
export const askGemini = (
	config: GeminiConfig | undefined,
	{
		question,
		attachments = [],
	}: Pick<FamilyQuestion, "question" | "attachments">,
	family: Pick<FamilyTools, "rules" | "tools" | "run">,
): Effect.Effect<
	{ text: string; model: string; followUps: string[] },
	GeminiChatError | ApiFailure
> =>
	Effect.gen(function* () {
		if (config === undefined)
			return yield* new GeminiChatError({
				reason: "unavailable",
				message: "Gemini is not configured (GEMINI_API_KEY)",
			});
		const tools = family.tools.map(({ name, description, parameters }) => ({
			type: "function",
			name,
			description,
			parameters,
		}));
		// Sent again each round (stateless); never logged or stored by the server.
		const history: unknown[] = [
			{
				type: "user_input",
				content: [
					...attachments.map(attachmentContent),
					{ type: "text", text: question },
				],
			},
		];
		const deadline = AbortSignal.timeout(answerBudgetMs);
		for (let round = 0; round <= maxRounds; round++) {
			const reply = yield* interact(
				config,
				{
					model: GEMINI_CHAT_MODEL,
					store: false,
					system_instruction: family.rules,
					input: history,
					tools,
					response_format: answerFormat,
					// About 2000 characters of answer plus 3 short follow-ups: short enough to read on a
					// phone and to speak.
					generation_config: { thinking_level: "low", max_output_tokens: 1280 },
				},
				deadline,
			);
			const { calls } = reply;
			if (reply.status === "completed" && calls.length === 0)
				return yield* finalAnswer(reply.text, reply.model);
			if (reply.status !== "requires_action" || calls.length === 0)
				return yield* upstream("Gemini did not complete the answer");
			history.push(
				...reply.raw,
				...(yield* functionResults(family.run, calls)),
			);
		}
		return yield* upstream(
			`Gemini still called tools after ${maxRounds} rounds`,
		);
	});
