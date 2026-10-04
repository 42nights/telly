import { setTimeout as sleep } from "node:timers/promises";
import type { MedicineDetectionRequest } from "@health/contracts/vision";
import { Data, Effect, Schema } from "effect";

/** Pinned so a provider alias change cannot silently change detection behavior. */
export const GEMINI_VISION_MODEL = "gemini-3.8-flash";
export const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash";

/** 429 and 503 are Google's "high demand" refusals: nothing ran, so a retry is safe and unbilled. */
export const overloaded = (status: number) => status === 429 || status === 503;

/**
 * Sends one interaction. When the model is overloaded it tries the fallback model at once, then
 * both again after each wait in `backoffMs`. Other replies, including errors, return at once. The
 * last overloaded reply returns when every try was refused; `signal` also ends a wait.
 */
export const postInteraction = async (
	{ apiKey, baseUrl }: Pick<GeminiConfig, "apiKey" | "baseUrl">,
	body: Readonly<Record<string, unknown>> & { readonly model: string },
	signal: AbortSignal,
	backoffMs: readonly number[] = [],
): Promise<{ readonly response: Response; readonly model: string }> => {
	const send = async (model: string) => ({
		model,
		response: await fetch(new URL("/v1beta/interactions", baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
			body: JSON.stringify({ ...body, model }),
			signal,
		}),
	});
	const models =
		body.model === GEMINI_FALLBACK_MODEL
			? [body.model]
			: [body.model, GEMINI_FALLBACK_MODEL];
	const retries = [0, ...backoffMs]
		.flatMap((wait) =>
			models.map((model, index) => ({ model, wait: index === 0 ? wait : 0 })),
		)
		.slice(1);
	let reply = await send(body.model);
	for (const { model, wait } of retries) {
		if (!overloaded(reply.response.status)) break;
		await reply.response.body?.cancel();
		if (wait > 0) await sleep(wait, undefined, { signal });
		reply = await send(model);
	}
	return reply;
};

export type GeminiConfig = {
	readonly apiKey: string;
	/** `https://generativelanguage.googleapis.com`, or a gateway/proxy with the same API. */
	readonly baseUrl: string;
	/** Upper bound for one provider call, including reading its response. */
	readonly timeout?: number;
	/** Chat only: waits before each extra try of an overloaded call. Tests set short ones. */
	readonly overloadBackoffMs?: readonly number[];
};

/** A provider failure. `reason` is for logs and status mapping only; it never carries provider text. */
class VisionUpstreamError extends Data.TaggedError("VisionUpstreamError")<{
	readonly reason: "network" | "timeout" | "http" | "invalid_response";
	readonly status?: number;
}> {}

/** One box as Gemini reports it: `[ymin, xmin, ymax, xmax]` normalized to 0–1000 of the sent image. */
export type GeminiBox = {
	readonly box: readonly [number, number, number, number];
	readonly label: string | null;
	readonly confidence: number;
};

type MedicineDetector = (
	image: MedicineDetectionRequest["image"],
) => Effect.Effect<
	{ readonly boxes: readonly GeminiBox[]; readonly model: string },
	VisionUpstreamError
>;

const Coordinate = Schema.Finite.check(
	Schema.isBetween({ minimum: 0, maximum: 1000 }),
);

// Model output schema, sent to Gemini as JSON Schema and enforced again here.
const Detections = Schema.Struct({
	detections: Schema.Array(
		Schema.Struct({
			box_2d: Schema.Tuple([Coordinate, Coordinate, Coordinate, Coordinate]),
			label: Schema.String,
			label_readable: Schema.Boolean,
			confidence: Schema.Finite.check(
				Schema.isBetween({ minimum: 0, maximum: 1 }),
			),
		}),
	),
});

const outputSchema = {
	type: "object",
	properties: {
		detections: {
			type: "array",
			items: {
				type: "object",
				properties: {
					box_2d: {
						type: "array",
						items: { type: "integer" },
						description: "[ymin, xmin, ymax, xmax] normalized to 0-1000.",
					},
					label: {
						type: "string",
						description:
							"Medicine name printed on the container, exactly as readable; empty if unreadable.",
					},
					label_readable: { type: "boolean" },
					confidence: {
						type: "number",
						description: "0-1 confidence that this is a medicine container.",
					},
				},
				required: ["box_2d", "label", "label_readable", "confidence"],
			},
		},
	},
	required: ["detections"],
};

const prompt =
	"Find every medicine container in the image: medicine boxes, pill bottles, and blister packs. " +
	"For each, return box_2d as [ymin, xmin, ymax, xmax] normalized to 0-1000. " +
	"Set label to the medicine name printed on it only if you can read it; never guess a name " +
	"from color, shape, or loose pills. Return an empty list when there is none.";

// Interactions API response: only the fields this adapter reads.
const Interaction = Schema.Struct({
	status: Schema.String,
	steps: Schema.Array(
		Schema.Struct({
			type: Schema.String,
			content: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						type: Schema.String,
						text: Schema.optionalKey(Schema.String),
					}),
				),
			),
		}),
	),
});

const invalid = () => new VisionUpstreamError({ reason: "invalid_response" });

const parseDetections = (body: unknown) =>
	Effect.gen(function* () {
		const interaction = yield* Schema.decodeUnknownEffect(Interaction)(
			body,
		).pipe(Effect.mapError(invalid));
		if (interaction.status !== "completed")
			return yield* Effect.fail(invalid());
		const text = interaction.steps
			.filter((step) => step.type === "model_output")
			.flatMap((step) => step.content ?? [])
			.map((part) => part.text ?? "")
			.join("");
		const { detections } = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(Detections),
		)(text).pipe(Effect.mapError(invalid));
		const boxes: GeminiBox[] = [];
		for (const { box_2d, label, label_readable, confidence } of detections) {
			const [ymin, xmin, ymax, xmax] = box_2d;
			if (ymin >= ymax || xmin >= xmax) return yield* Effect.fail(invalid());
			const readable = label_readable && label.trim() !== "";
			boxes.push({
				box: box_2d,
				label: readable ? label.trim() : null,
				confidence,
			});
		}
		return boxes;
	});

/**
 * Gemini object detection through the Interactions API (`POST /v1beta/interactions`). The request
 * sets `store: false`, so Google keeps no copy for server-side state. The key stays on the server,
 * and the effect aborts the HTTP call when interrupted or after `timeout` milliseconds.
 */
export const createGeminiDetector =
	({ apiKey, baseUrl, timeout = 20_000 }: GeminiConfig): MedicineDetector =>
	(image) =>
		Effect.tryPromise({
			try: (signal) =>
				postInteraction(
					{ apiKey, baseUrl },
					{
						model: GEMINI_VISION_MODEL,
						store: false,
						input: [
							{ type: "text", text: prompt },
							{ type: "image", mime_type: image.type, data: image.data },
						],
						response_format: {
							type: "text",
							mime_type: "application/json",
							schema: outputSchema,
						},
						generation_config: {
							thinking_level: "low",
							max_output_tokens: 4096,
						},
					},
					signal,
				),
			catch: () => new VisionUpstreamError({ reason: "network" }),
		}).pipe(
			Effect.flatMap(({ response, model }) =>
				response.ok
					? Effect.tryPromise({
							try: () => response.json(),
							catch: invalid,
						}).pipe(
							Effect.flatMap(parseDetections),
							Effect.map((boxes) => ({ boxes, model })),
						)
					: Effect.fail(
							new VisionUpstreamError({
								reason: "http",
								status: response.status,
							}),
						),
			),
			Effect.timeoutOrElse({
				duration: timeout,
				orElse: () =>
					Effect.fail(new VisionUpstreamError({ reason: "timeout" })),
			}),
		);
