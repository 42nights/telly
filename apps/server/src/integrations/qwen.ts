import type { HealthSample } from "@health/contracts";
import { CueOutput, cueFormat } from "@health/contracts/cues";
import { Data, Duration, Effect, Schema } from "effect";

/**
 * A River dedicated deployment of the trained Qwen checkpoint. River serves it through an
 * OpenAI-compatible API; `baseUrl` is the deployment's `base_url`, which already ends in the API
 * prefix. See training/qwen/README.md for how `train.py deploy` prints these values.
 */
export type QwenConfig = {
	readonly baseUrl: string;
	readonly deployment: string;
	readonly checkpoint: string;
	readonly apiKey: string;
};

/**
 * The deployment config from all four values, or `undefined` from none (the cue route then answers
 * `unavailable`). A partial set is a deployment mistake, so startup fails, as for sign-in.
 */
export const qwenConfigFrom = (env: {
	readonly QWEN_BASE_URL?: string | undefined;
	readonly QWEN_DEPLOYMENT?: string | undefined;
	readonly QWEN_CHECKPOINT?: string | undefined;
	readonly RIVER_API_KEY?: string | undefined;
}): QwenConfig | undefined => {
	const baseUrl = env.QWEN_BASE_URL;
	const deployment = env.QWEN_DEPLOYMENT;
	const checkpoint = env.QWEN_CHECKPOINT;
	const apiKey = env.RIVER_API_KEY;
	if (baseUrl && deployment && checkpoint && apiKey)
		return { baseUrl, deployment, checkpoint, apiKey };
	if (baseUrl || deployment || checkpoint || apiKey)
		throw new Error(
			"Set all of QWEN_BASE_URL, QWEN_DEPLOYMENT, QWEN_CHECKPOINT, and RIVER_API_KEY, or none",
		);
	return undefined;
};

/** No deployment is configured, or River reports it is not serving. */
class QwenUnavailable extends Data.TaggedError("QwenUnavailable")<{
	readonly message: string;
}> {}

/** The deployment failed, timed out, or replied with something other than one valid cue. */
class QwenUpstreamError extends Data.TaggedError("QwenUpstreamError")<{
	readonly message: string;
}> {}

const requestTimeout = Duration.seconds(20);

// Providers add fields freely; only the parts read here are decoded.
const ChatCompletion = Schema.Struct({
	choices: Schema.NonEmptyArray(
		Schema.Struct({
			message: Schema.Struct({ content: Schema.String }),
			finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
});

const decodeCompletion = Schema.decodeUnknownEffect(ChatCompletion);
const decodeCue = Schema.decodeUnknownEffect(Schema.fromJsonString(CueOutput));

/** The user message. `train.py` renders training examples the same way, byte for byte. */
export const renderCueInput = (
	samples: ReadonlyArray<
		Pick<HealthSample, "metric" | "value" | "unit" | "sourceTime">
	>,
) =>
	JSON.stringify({
		readings: samples.map(({ metric, value, unit, sourceTime }) => ({
			metric,
			value,
			unit,
			sourceTime,
		})),
	});

const upstream = (message: string) => new QwenUpstreamError({ message });

type Reply = { readonly status: number; readonly body: unknown };

/** One bounded chat-completion call. The fetch aborts when the effect is interrupted. */
const postChat = (
	config: QwenConfig,
	samples: Parameters<typeof renderCueInput>[0],
) =>
	Effect.tryPromise({
		try: async (signal): Promise<Reply> => {
			const response = await fetch(
				`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
				{
					method: "POST",
					signal,
					headers: {
						authorization: `Bearer ${config.apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: config.deployment,
						messages: [
							{ role: "system", content: cueFormat.system },
							{ role: "user", content: renderCueInput(samples) },
						],
						temperature: 0,
						max_tokens: 128,
						stream: false,
						// Qwen3.5 thinks by default; turn it off so the reply is the bare JSON cue.
						chat_template_kwargs: { enable_thinking: false },
					}),
				},
			);
			return {
				status: response.status,
				body: response.ok ? await response.json() : null,
			};
		},
		catch: () => upstream("Qwen deployment request failed"),
	}).pipe(
		Effect.timeoutOrElse({
			duration: requestTimeout,
			orElse: () => Effect.fail(upstream("Qwen deployment timed out")),
		}),
	);

/** Exactly one valid cue from the reply, or the typed reason there is none. */
const readCue = ({ status, body }: Reply) =>
	Effect.gen(function* () {
		if (status === 429 || status === 503)
			return yield* new QwenUnavailable({
				message: "Qwen deployment is not serving",
			});
		if (body === null)
			return yield* upstream(`Qwen deployment returned HTTP ${status}`);
		const completion = yield* decodeCompletion(body).pipe(
			Effect.mapError(() => upstream("Qwen deployment reply is malformed")),
		);
		const [choice] = completion.choices;
		if (choice.finish_reason === "length")
			return yield* upstream("Qwen deployment cut the cue short");
		return yield* decodeCue(choice.message.content, {
			onExcessProperty: "error",
		}).pipe(Effect.mapError(() => upstream("Qwen reply is not a valid cue")));
	});

/**
 * Asks the deployment for one cue. Interrupting the effect (a client disconnect) cancels the
 * provider call. Nothing is retried: the route answers once per request. Error messages never
 * carry the provider body, the key, or health values.
 */
export const requestCue = (
	config: QwenConfig | undefined,
	samples: Parameters<typeof renderCueInput>[0],
) =>
	config === undefined
		? Effect.fail(
				new QwenUnavailable({
					message: "Qwen inference is not configured on this server",
				}),
			)
		: postChat(config, samples).pipe(Effect.flatMap(readCue));
