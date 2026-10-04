import type { MedicineDetectionRequest } from "@health/contracts";
import { Data, Effect, Schema } from "effect";

/** Pinned so a provider alias change cannot silently change detection behavior. */
export const GEMINI_VISION_MODEL = "gemini-3.8-flash";

export type GeminiConfig = {
	readonly apiKey: string;
	/** `https://generativelanguage.googleapis.com`, or a gateway/proxy with the same API. */
	readonly baseUrl: string;
	/** Upper bound for one provider call, including reading its response. */
	readonly timeout?: number;
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

export type MedicineDetector = (
	image: MedicineDetectionRequest["image"],
) => Effect.Effect<readonly GeminiBox[], VisionUpstreamError>;

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
				fetch(new URL("/v1beta/interactions", baseUrl), {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-goog-api-key": apiKey,
					},
					body: JSON.stringify({
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
					}),
					signal,
				}),
			catch: () => new VisionUpstreamError({ reason: "network" }),
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.tryPromise({ try: () => response.json(), catch: invalid })
					: Effect.fail(
							new VisionUpstreamError({
								reason: "http",
								status: response.status,
							}),
						),
			),
			Effect.flatMap(parseDetections),
			Effect.timeoutOrElse({
				duration: timeout,
				orElse: () =>
					Effect.fail(new VisionUpstreamError({ reason: "timeout" })),
			}),
		);
