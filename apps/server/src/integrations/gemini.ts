import { setTimeout as sleep } from "node:timers/promises";
import {
	LANDMARKS,
	Landmark,
	OBJECT_CATEGORIES,
	ObjectCategory,
	type ObjectDetectionRequest,
} from "@health/contracts/vision";
import { Data, Effect, Schema } from "effect";

/** Pinned so a provider alias change cannot silently change detection behavior. */
export const GEMINI_VISION_MODEL = "gemini-3.8-flash";
export const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash";

/** 429 and 503 are Google's "high demand" refusals: nothing ran, so a retry is safe and unbilled. */
export const overloaded = (status: number) => status === 429 || status === 503;

type Reply = { readonly response: Response; readonly model: string };

/**
 * Sends one interaction. When the model is overloaded it tries the fallback model at once, then
 * both again after each wait in `backoffMs`. With `primaryTimeoutMs`, a primary model that has not
 * answered by then is cut off and counts as overloaded, so a slow primary leaves time for the
 * fallback. Other replies, including errors, return at once. The last overloaded reply returns
 * when every try was refused; `signal` also ends a wait.
 */
export const postInteraction = async (
	{ apiKey, baseUrl }: Pick<GeminiConfig, "apiKey" | "baseUrl">,
	body: Readonly<Record<string, unknown>> & { readonly model: string },
	signal: AbortSignal,
	{
		backoffMs = [],
		primaryTimeoutMs,
	}: {
		readonly backoffMs?: readonly number[];
		readonly primaryTimeoutMs?: number;
	} = {},
): Promise<Reply> => {
	const send = async (model: string): Promise<Reply | undefined> => {
		const limit = new AbortController();
		// The fallback has no own limit, so the last try always gets a reply or fails for real.
		const timer =
			primaryTimeoutMs === undefined || model === GEMINI_FALLBACK_MODEL
				? undefined
				: setTimeout(() => limit.abort(), primaryTimeoutMs);
		try {
			return {
				model,
				response: await fetch(new URL("/v1beta/interactions", baseUrl), {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-goog-api-key": apiKey,
					},
					body: JSON.stringify({ ...body, model }),
					signal: AbortSignal.any([signal, limit.signal]),
				}),
			};
		} catch (error) {
			if (limit.signal.aborted && !signal.aborted) return undefined;
			throw error;
		} finally {
			clearTimeout(timer);
		}
	};
	const models =
		body.model === GEMINI_FALLBACK_MODEL
			? [body.model]
			: [body.model, GEMINI_FALLBACK_MODEL];
	let reply: Reply | undefined;
	for (const wait of [0, ...backoffMs])
		for (const [index, model] of models.entries()) {
			if (reply !== undefined && !overloaded(reply.response.status))
				return reply;
			await reply?.response.body?.cancel();
			if (index === 0 && wait > 0) await sleep(wait, undefined, { signal });
			reply = await send(model);
		}
	// Unreachable: the last try is the fallback, or the only model, and neither has a limit.
	if (reply === undefined) throw new Error("Gemini gave no reply");
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
	readonly category: ObjectCategory;
	readonly label: string | null;
	readonly confidence: number;
};

type ObjectDetector = (
	image: ObjectDetectionRequest["image"],
	landmarks?: boolean,
) => Effect.Effect<
	{
		readonly boxes: readonly GeminiBox[];
		readonly landmarks: readonly {
			readonly box: GeminiBox["box"];
			readonly kind: Landmark;
		}[];
		readonly model: string;
	},
	VisionUpstreamError
>;

const Coordinate = Schema.Finite.check(
	Schema.isBetween({ minimum: 0, maximum: 1000 }),
);

const Box2d = Schema.Tuple([Coordinate, Coordinate, Coordinate, Coordinate]);

// Model output schema, sent to Gemini as JSON Schema and enforced again here.
const Detections = Schema.Struct({
	detections: Schema.Array(
		Schema.Struct({
			box_2d: Box2d,
			category: ObjectCategory,
			label: Schema.String,
			label_readable: Schema.Boolean,
			confidence: Schema.Finite.check(
				Schema.isBetween({ minimum: 0, maximum: 1 }),
			),
		}),
	),
	landmarks: Schema.optionalKey(
		Schema.Array(Schema.Struct({ box_2d: Box2d, kind: Landmark })),
	),
});

const box2d = {
	type: "array",
	items: { type: "integer" },
	description: "[ymin, xmin, ymax, xmax] normalized to 0-1000.",
};

const outputSchema = {
	type: "object",
	properties: {
		detections: {
			type: "array",
			items: {
				type: "object",
				properties: {
					box_2d: box2d,
					category: { type: "string", enum: [...OBJECT_CATEGORIES] },
					label: {
						type: "string",
						description:
							"Medicine: the name printed on it, exactly as readable, empty if unreadable. Anything else: a short everyday name, 1-4 words.",
					},
					label_readable: { type: "boolean" },
					confidence: {
						type: "number",
						description: "0-1 confidence in the category.",
					},
				},
				required: [
					"box_2d",
					"category",
					"label",
					"label_readable",
					"confidence",
				],
			},
		},
	},
	required: ["detections"],
};

const prompt =
	"Find the personal objects a person might lose in the image: keys, glasses, a wallet, a phone, " +
	"a remote, medicine (boxes, pill bottles, blister packs), a hearing aid, a bag, or another small " +
	"belonging. Ignore people, pets, furniture, walls, and the floor. Put the main object first: the " +
	"one the camera is pointed at, near the center and in focus. Return at most 5. " +
	"For each, return box_2d as [ymin, xmin, ymax, xmax] normalized to 0-1000. " +
	"For medicine, set label to the medicine name printed on it only if you can read it; never guess " +
	"a name from color, shape, or loose pills. For anything else, set label to a short everyday name " +
	'such as "keys" or "reading glasses". Return an empty list when there is none.';

const landmarkQuestion = {
	prompt:
		`${prompt} Separately, in landmarks, box each of these room landmarks that you can clearly ` +
		`see: ${LANDMARKS.join(", ")}. Box each cabinet door, drawer, and shelf on its own, at most ` +
		"12 landmarks. Return an empty landmarks list when the picture is too dark or blurry to tell.",
	schema: {
		...outputSchema,
		properties: {
			...outputSchema.properties,
			landmarks: {
				type: "array",
				items: {
					type: "object",
					properties: {
						box_2d: box2d,
						kind: { type: "string", enum: [...LANDMARKS] },
					},
					required: ["box_2d", "kind"],
				},
			},
		},
		required: ["detections", "landmarks"],
	},
};

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

/** The model's JSON text of a completed interaction, decoded with `schema`. */
const modelJson = <A>(body: unknown, schema: Schema.Decoder<A>) =>
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
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
			text,
		).pipe(Effect.mapError(invalid));
	});

/** Decodes the model's JSON. Medicine keeps only a printed name it could read; others keep a name. */
const parseDetections = (body: unknown) =>
	Effect.gen(function* () {
		const { detections, landmarks = [] } = yield* modelJson(body, Detections);
		const boxes: GeminiBox[] = [];
		for (const d of detections) {
			const [ymin, xmin, ymax, xmax] = d.box_2d;
			if (ymin >= ymax || xmin >= xmax) return yield* Effect.fail(invalid());
			const label = d.label.trim();
			const readable =
				label !== "" && (d.category !== "medicine" || d.label_readable);
			boxes.push({
				box: d.box_2d,
				category: d.category,
				label: readable ? label : null,
				confidence: d.confidence,
			});
		}
		for (const {
			box_2d: [ymin, xmin, ymax, xmax],
		} of landmarks)
			if (ymin >= ymax || xmin >= xmax) return yield* Effect.fail(invalid());
		return {
			boxes,
			landmarks: landmarks.map(({ box_2d, kind }) => ({ box: box_2d, kind })),
		};
	});

// ponytail: fixed split from one load probe on 2026-10-04 (3.8 Flash 9.5–14 s, 3.5 Flash 16.5–17.5 s
// for one word); tune when timings are measured again.
const primaryShare = 0.4;

/**
 * One image question to Gemini through the Interactions API (`POST /v1beta/interactions`), with a
 * JSON answer that `parse` reads. The request sets `store: false`, so Google keeps no copy for
 * server-side state. The key stays on the server, and the effect aborts the HTTP call when
 * interrupted or after `timeout` milliseconds. The primary model gets 40% of `timeout`; when it is
 * slow or overloaded, the fallback gets the rest.
 */
const askAboutImage = <A>(
	{ apiKey, baseUrl, timeout = 30_000 }: GeminiConfig,
	image: { readonly type: string; readonly data: string },
	question: { readonly prompt: string; readonly schema: object },
	parse: (body: unknown) => Effect.Effect<A, VisionUpstreamError>,
) =>
	Effect.tryPromise({
		try: (signal) =>
			postInteraction(
				{ apiKey, baseUrl },
				{
					model: GEMINI_VISION_MODEL,
					store: false,
					input: [
						{ type: "text", text: question.prompt },
						{ type: "image", mime_type: image.type, data: image.data },
					],
					response_format: {
						type: "text",
						mime_type: "application/json",
						schema: question.schema,
					},
					generation_config: {
						thinking_level: "low",
						max_output_tokens: 4096,
					},
				},
				signal,
				{ primaryTimeoutMs: timeout * primaryShare },
			),
		catch: () => new VisionUpstreamError({ reason: "network" }),
	}).pipe(
		Effect.flatMap(({ response, model }) =>
			response.ok
				? Effect.tryPromise({
						try: () => response.json(),
						catch: invalid,
					}).pipe(
						Effect.flatMap(parse),
						Effect.map((value) => ({ value, model })),
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
			orElse: () => Effect.fail(new VisionUpstreamError({ reason: "timeout" })),
		}),
	);

/** Gemini detection of personal objects in one camera frame. */
export const createGeminiDetector =
	(config: GeminiConfig): ObjectDetector =>
	(image, landmarks = false) =>
		askAboutImage(
			config,
			image,
			landmarks ? landmarkQuestion : { prompt, schema: outputSchema },
			parseDetections,
		).pipe(Effect.map(({ value, model }) => ({ ...value, model })));

const ItemAnswer = Schema.Struct({
	item: Schema.String,
	category: ObjectCategory,
	place: Schema.String,
	confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

/** The main personal item in a photo and where it is. Empty strings: not seen. */
export type PhotoItem = typeof ItemAnswer.Type;

const itemQuestion = {
	prompt:
		"A person took this photo to remember where they keep one of their things. Name the one main " +
		"personal item in it in 1 to 4 plain words, as its owner would say it, such as 'house keys', " +
		"'reading glasses', 'wallet', 'TV remote', 'hearing aids', or the medicine name printed on a " +
		"medicine container ('Lisinopril bottle'). Never guess a medicine name you cannot read. " +
		"Then say where it is, as a room or a landmark that a person knows, in at most 8 words, " +
		"such as 'hall table, by the front door'. Use an empty item when no personal item is clear, " +
		"and an empty place when the photo does not show where it is.",
	schema: {
		type: "object",
		properties: {
			item: { type: "string" },
			category: { type: "string", enum: [...OBJECT_CATEGORIES] },
			place: { type: "string" },
			confidence: {
				type: "number",
				description: "0-1 confidence that the item is named correctly.",
			},
		},
		required: ["item", "category", "place", "confidence"],
	},
};

/** Gemini names the main item in a photo, its category, and the place it is in. */
export const createItemReader =
	(config: GeminiConfig) =>
	(image: { readonly type: string; readonly data: string }) =>
		askAboutImage(config, image, itemQuestion, (body) =>
			Effect.map(
				modelJson(body, ItemAnswer),
				(answer): PhotoItem => ({
					...answer,
					item: answer.item.trim(),
					place: answer.place.trim(),
				}),
			),
		);
