// Grokbot family agent: a Grok model with server-side tools, called through the xAI Responses API
// (https://docs.x.ai/developers/rest-api-reference/inference/responses). xAI's Grok Bot app
// (https://docs.x.ai/grok-bot/overview) has no server API, so this is the server-callable Grok agent.
// Requests set `store: false`: xAI keeps no copy of the family's records for later retrieval.
import { Data, Effect, Schema } from "effect";

export type GrokbotConfig = {
	readonly apiKey: string;
	readonly model: string;
	/** `https://api.x.ai/v1`, or a regional endpoint. */
	readonly baseUrl: string;
};

/** The provider failed or sent something unusable. Carries no provider text, records, or key. */
export class GrokbotError extends Data.TaggedError("GrokbotError")<{
	readonly reason:
		| "timeout"
		| "network"
		| "http"
		| "invalid_response"
		| "incomplete"
		| "turn_limit";
	readonly status?: number;
}> {}

/**
 * A function the model may call. `run` gets the model's parsed arguments and returns JSON-safe
 * data; data the model must see as a tool error is a normal result, and a failure ends the answer.
 */
export type GrokbotTool<E> = {
	readonly name: string;
	readonly description: string;
	/** JSON Schema of the arguments; its root must be an object. */
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly run: (args: unknown) => Effect.Effect<unknown, E>;
};

const FunctionCall = Schema.Struct({
	type: Schema.Literal("function_call"),
	call_id: Schema.String,
	name: Schema.String,
	arguments: Schema.String,
});
const Message = Schema.Struct({
	type: Schema.Literal("message"),
	content: Schema.Array(
		Schema.Struct({
			type: Schema.String,
			text: Schema.optionalKey(Schema.String),
		}),
	),
});
const Reply = Schema.Struct({
	status: Schema.String,
	model: Schema.String,
	// Reasoning and server-side tool items keep only their type.
	output: Schema.Array(
		Schema.Union([
			FunctionCall,
			Message,
			Schema.Struct({ type: Schema.String }),
		]),
	),
});

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TURNS = 4;

const respond = (config: GrokbotConfig, body: unknown) =>
	Effect.tryPromise({
		try: (signal) =>
			fetch(`${config.baseUrl}/responses`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${config.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				// Interruption (a client disconnect) or the timeout cancels the request.
				signal: AbortSignal.any([
					signal,
					AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				]),
			}),
		catch: (error) =>
			new GrokbotError({
				reason:
					error instanceof DOMException && error.name === "TimeoutError"
						? "timeout"
						: "network",
			}),
	}).pipe(
		Effect.flatMap((response) =>
			response.ok
				? Effect.tryPromise({
						try: () => response.json(),
						catch: () => new GrokbotError({ reason: "invalid_response" }),
					})
				: Effect.fail(
						new GrokbotError({ reason: "http", status: response.status }),
					),
		),
		Effect.flatMap((json) =>
			Schema.decodeUnknownEffect(Reply)(json).pipe(
				Effect.mapError(() => new GrokbotError({ reason: "invalid_response" })),
			),
		),
	);

const callTool = <E>(
	tools: ReadonlyArray<GrokbotTool<E>>,
	name: string,
	raw: string,
): Effect.Effect<unknown, E> => {
	const tool = tools.find((t) => t.name === name);
	if (tool === undefined)
		return Effect.succeed({ error: `unknown tool ${name}` });
	let args: unknown;
	try {
		args = JSON.parse(raw);
	} catch {
		return Effect.succeed({ error: "arguments are not valid JSON" });
	}
	return tool.run(args);
};

/**
 * Asks the model one question and runs the tools it calls until it answers in text. Fails when the
 * reply is empty, incomplete, or still calling tools after the turn limit; it never makes up an answer.
 */
export const askGrokbot = <E>(
	config: GrokbotConfig,
	request: {
		readonly instructions: string;
		readonly question: string;
		readonly tools: ReadonlyArray<GrokbotTool<E>>;
	},
) =>
	Effect.gen(function* () {
		const tools = request.tools.map(({ name, description, parameters }) => ({
			type: "function",
			name,
			description,
			parameters,
		}));
		const input: Array<unknown> = [{ role: "user", content: request.question }];
		for (let turn = 0; turn < MAX_TURNS; turn++) {
			const reply = yield* respond(config, {
				model: config.model,
				instructions: request.instructions,
				input,
				tools,
				store: false,
				// About 2000 characters: short enough to read on a phone and to speak.
				max_output_tokens: 600,
			});
			if (reply.status !== "completed")
				return yield* new GrokbotError({ reason: "incomplete" });
			const calls = reply.output.filter((item) => "call_id" in item);
			if (calls.length === 0) {
				const text = reply.output
					.flatMap((item) => ("content" in item ? item.content : []))
					.map((part) => part.text ?? "")
					.join("")
					.trim();
				if (text === "")
					return yield* new GrokbotError({ reason: "invalid_response" });
				return { text, model: reply.model };
			}
			for (const call of calls) {
				const output = yield* callTool(
					request.tools,
					call.name,
					call.arguments,
				);
				input.push(call, {
					type: "function_call_output",
					call_id: call.call_id,
					output: JSON.stringify(output),
				});
			}
		}
		return yield* new GrokbotError({ reason: "turn_limit" });
	});
