import { setTimeout as sleep } from "node:timers/promises";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
	Client,
	credentials,
	status as grpcStatus,
	Metadata,
} from "@grpc/grpc-js";
import type { HealthSample } from "@health/contracts";
import { CueOutput, cueFormat } from "@health/contracts/cues";
import { Data, Duration, Effect, Schema } from "effect";

/**
 * The trained Qwen checkpoint on River queued inference. River has no dedicated deployment for
 * the base model on our account (training/qwen/README.md), so the server calls River's gRPC API
 * `river.api.v1.RiverService` at `baseUrl` (`https://api.river.ai`) directly: one OpenAI-format
 * chat request for the `river://` checkpoint of `baseModel`, then polls for the reply.
 */
export type QwenConfig = {
	readonly baseUrl: string;
	readonly baseModel: string;
	readonly checkpoint: string;
	readonly apiKey: string;
};

/**
 * The River config from all four values, or `undefined` from none (the cue route then answers
 * `unavailable`). A partial set is a deployment mistake, so startup fails, as for sign-in.
 */
export const qwenConfigFrom = (env: {
	readonly QWEN_BASE_URL?: string | undefined;
	readonly QWEN_BASE_MODEL?: string | undefined;
	readonly QWEN_CHECKPOINT?: string | undefined;
	readonly RIVER_API_KEY?: string | undefined;
}): QwenConfig | undefined => {
	const baseUrl = env.QWEN_BASE_URL;
	const baseModel = env.QWEN_BASE_MODEL;
	const checkpoint = env.QWEN_CHECKPOINT;
	const apiKey = env.RIVER_API_KEY;
	if (baseUrl && baseModel && checkpoint && apiKey)
		return { baseUrl, baseModel, checkpoint, apiKey };
	if (baseUrl || baseModel || checkpoint || apiKey)
		throw new Error(
			"Set all of QWEN_BASE_URL, QWEN_BASE_MODEL, QWEN_CHECKPOINT, and RIVER_API_KEY, or none",
		);
	return undefined;
};

/** No deployment is configured, or River has no capacity for the request. */
class QwenUnavailable extends Data.TaggedError("QwenUnavailable")<{
	readonly message: string;
}> {}

/** River failed, timed out, or replied with something other than one valid cue. */
class QwenUpstreamError extends Data.TaggedError("QwenUpstreamError")<{
	readonly message: string;
}> {}

// River's queue answered a cue in 3 to 12 seconds on 2026-10-04.
const requestTimeout = Duration.seconds(30);

// Providers add fields freely; only the parts read here are decoded.
const ChatCompletion = Schema.Struct({
	choices: Schema.NonEmptyArray(
		Schema.Struct({
			message: Schema.Struct({ content: Schema.String }),
			finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
});

const decodeCompletion = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ChatCompletion),
);
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

/** A protobuf message of string fields, by field number. */
export const encodeStrings = (
	fields: ReadonlyArray<readonly [number, string]>,
) => {
	const writer = new BinaryWriter();
	for (const [field, value] of fields)
		writer.tag(field, WireType.LengthDelimited).string(value);
	return Buffer.from(writer.finish());
};

/** The length-delimited (bytes) and varint (number) fields of one protobuf message, by number. */
const fields = (bytes: Uint8Array) => {
	const reader = new BinaryReader(bytes);
	const found = new Map<number, Uint8Array | number>();
	while (reader.pos < reader.len) {
		const [field, type] = reader.tag();
		if (type === WireType.LengthDelimited) found.set(field, reader.bytes());
		else if (type === WireType.Varint) found.set(field, reader.int32());
		else reader.skip(type);
	}
	return found;
};

const text = (value: Uint8Array | number | undefined) =>
	value instanceof Uint8Array ? new TextDecoder().decode(value) : "";

/** The provider's HTTP status and body for the chat request. */
type Reply = { readonly status: number; readonly body: string };

/**
 * `RetrieveFutureResponse`: `chat_complete` (12) carries the reply and `try_again` (1) is pending.
 * Anything else, such as `failed` (2), is a failure.
 */
const decodeFuture = (bytes: Uint8Array): Reply | "pending" | "failed" => {
	const response = fields(bytes);
	const chat = response.get(12);
	if (!(chat instanceof Uint8Array))
		return response.has(1) ? "pending" : "failed";
	const reply = fields(chat);
	const code = reply.get(2);
	return {
		status: typeof code === "number" ? code : 0,
		body: text(reply.get(1)),
	};
};

/** One unary call on River's service. Aborting the signal cancels it. */
const unary = <A>(
	client: Client,
	method: string,
	request: Buffer,
	decode: (bytes: Buffer) => A,
	metadata: Metadata,
	signal: AbortSignal,
) => {
	signal.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<A>();
	const call = client.makeUnaryRequest(
		`/river.api.v1.RiverService/${method}`,
		(bytes: Buffer) => bytes,
		decode,
		request,
		metadata,
		(error, value) =>
			error || value === undefined ? reject(error) : resolve(value),
	);
	signal.addEventListener("abort", () => call.cancel(), { once: true });
	return promise;
};

const notServing = new Set<number>([
	grpcStatus.UNAVAILABLE,
	grpcStatus.RESOURCE_EXHAUSTED,
]);

/**
 * One bounded queued chat call, polled until River answers. Interrupting the effect cancels the
 * pending gRPC call.
 */
const askRiver = (
	config: QwenConfig,
	samples: Parameters<typeof renderCueInput>[0],
) =>
	Effect.tryPromise({
		try: async (signal): Promise<Reply> => {
			const url = new URL(config.baseUrl);
			const client = new Client(
				url.host,
				url.protocol === "http:"
					? credentials.createInsecure()
					: credentials.createSsl(),
			);
			const metadata = new Metadata();
			metadata.set("x-api-key", config.apiKey);
			try {
				const id = await unary(
					client,
					"ChatCompleteFromCheckpoint",
					// checkpoint_path (1), base_model (2), and request_json (3), as river-client sends them.
					encodeStrings([
						[1, config.checkpoint],
						[2, config.baseModel],
						[
							3,
							JSON.stringify({
								model: config.baseModel,
								messages: [
									{ role: "system", content: cueFormat.system },
									{ role: "user", content: renderCueInput(samples) },
								],
								temperature: 0,
								max_tokens: 128,
								// Qwen3.5 thinks by default; turn it off so the reply is the bare JSON cue.
								chat_template_kwargs: { enable_thinking: false },
							}),
						],
					]),
					// AsyncResponse.request_id (1)
					(bytes) => text(fields(bytes).get(1)),
					metadata,
					signal,
				);
				for (;;) {
					const future = await unary(
						client,
						"RetrieveFuture",
						encodeStrings([[1, id]]),
						decodeFuture,
						metadata,
						signal,
					);
					if (future === "failed") throw new Error("River request failed");
					if (future !== "pending") return future;
					await sleep(100, undefined, { signal });
				}
			} finally {
				client.close();
			}
		},
		catch: (error) =>
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			typeof error.code === "number" &&
			notServing.has(error.code)
				? new QwenUnavailable({ message: "River has no capacity for the cue" })
				: upstream("River cue request failed"),
	}).pipe(
		Effect.timeoutOrElse({
			duration: requestTimeout,
			orElse: () => Effect.fail(upstream("River cue request timed out")),
		}),
	);

/** Exactly one valid cue from the reply, or the typed reason there is none. */
const readCue = ({ status, body }: Reply) =>
	Effect.gen(function* () {
		if (status === 429 || status === 503)
			return yield* new QwenUnavailable({
				message: "River has no capacity for the cue",
			});
		if (status !== 200)
			return yield* upstream(`River chat returned HTTP ${status}`);
		const completion = yield* decodeCompletion(body).pipe(
			Effect.mapError(() => upstream("River chat reply is malformed")),
		);
		const [choice] = completion.choices;
		if (choice.finish_reason === "length")
			return yield* upstream("River chat cut the cue short");
		return yield* decodeCue(choice.message.content, {
			onExcessProperty: "error",
		}).pipe(Effect.mapError(() => upstream("Qwen reply is not a valid cue")));
	});

/**
 * Asks River for one cue. Interrupting the effect (a client disconnect) cancels the
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
		: askRiver(config, samples).pipe(Effect.flatMap(readCue));
