// Gemini chat with function calling through the Interactions API, stateless (`store: false`): the
// server sends the whole history each turn, so Google keeps no copy of the family's records.
// https://ai.google.dev/gemini-api/docs/function-calling (Stateless function calling)
import { Data, Effect, Schema } from "effect";
import type { FamilyTools } from "../family-tools";
import { ApiFailure } from "../http";
import type { GeminiConfig } from "./gemini";

/** Pinned so a provider alias change cannot silently change answers. */
const GEMINI_CHAT_MODEL = "gemini-3.8-flash";

const requestTimeoutMs = 30_000;
// Each round runs the tools the model called; the answer must come within this many rounds.
const maxRounds = 4;

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

const interact = (config: GeminiConfig, body: unknown) =>
	Effect.tryPromise({
		try: async (signal) => {
			const response = await fetch(
				new URL("/v1beta/interactions", config.baseUrl),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-goog-api-key": config.apiKey,
					},
					body: JSON.stringify(body),
					signal: AbortSignal.any([
						signal,
						AbortSignal.timeout(requestTimeoutMs),
					]),
				},
			);
			if (!response.ok) {
				await response.body?.cancel();
				throw upstream(`Gemini chat failed with HTTP ${response.status}`);
			}
			return parseReply(await response.json().catch(() => undefined));
		},
		catch: (cause) =>
			cause instanceof GeminiChatError
				? cause
				: upstream(
						cause instanceof DOMException && cause.name === "TimeoutError"
							? `Gemini chat timed out after ${requestTimeoutMs / 1000} s`
							: "Gemini could not be reached",
					),
	});

/**
 * Runs the calls in order through the family tools and returns their `function_result` steps. A
 * failed tool call stops the answer with its `ApiFailure`; the model never continues without data.
 */
const functionResults = (
	run: FamilyTools["run"],
	calls: ReadonlyArray<{ id: string; name: string; arguments?: unknown }>,
) =>
	Effect.forEach(calls, (call) =>
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
	);

/**
 * Asks Gemini one question and runs the tools it calls until it answers in text. Fails when the
 * reply is empty, incomplete, or still calling tools after the round limit; it never makes up an
 * answer. Interrupting it aborts the provider call.
 */
export const askGemini = (
	config: GeminiConfig | undefined,
	question: string,
	family: Pick<FamilyTools, "rules" | "tools" | "run">,
): Effect.Effect<
	{ text: string; model: string },
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
		const history: unknown[] = [
			{
				type: "user_input",
				content: [{ type: "text", text: question }],
			},
		];
		for (let round = 0; round <= maxRounds; round++) {
			const reply = yield* interact(config, {
				model: GEMINI_CHAT_MODEL,
				store: false,
				system_instruction: family.rules,
				input: history,
				tools,
				// About 2000 characters: short enough to read on a phone and to speak.
				generation_config: { thinking_level: "low", max_output_tokens: 1024 },
			});
			const { calls } = reply;
			if (reply.status === "completed" && calls.length === 0) {
				if (reply.text === "")
					return yield* upstream("Gemini sent an empty answer");
				return { text: reply.text, model: reply.model };
			}
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
