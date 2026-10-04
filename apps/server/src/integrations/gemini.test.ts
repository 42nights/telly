// A local protocol server stands in for the Gemini Interactions API. Test key only: this proves
// the adapter's side of the protocol, not a live Gemini call.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
	createGeminiDetector,
	GEMINI_FALLBACK_MODEL,
	GEMINI_VISION_MODEL,
	postInteraction,
} from "./gemini";

type Sent = {
	path: string;
	method: string;
	key: string | null;
	body: Record<string, unknown>;
};
const sent: Sent[] = [];
let reply: (model: string) => Response | Promise<Response>;
const server = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const body = (await request.json()) as Record<string, unknown>;
		sent.push({
			path: new URL(request.url).pathname,
			method: request.method,
			key: request.headers.get("x-goog-api-key"),
			body,
		});
		return reply(String(body.model));
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	sent.length = 0;
});

const config = { apiKey: "test-gemini-key", baseUrl: server.url.origin };
const signal = () => new AbortController().signal;

const interaction = (text: string, status = "completed") =>
	Response.json({
		status,
		steps: [
			{ type: "thought", content: [{ type: "text", text: "ignored" }] },
			{ type: "model_output", content: [{ type: "text", text }] },
		],
	});
const detections = (items: unknown[]) =>
	interaction(JSON.stringify({ detections: items }));

describe("postInteraction", () => {
	test("posts the body with the key to the Interactions endpoint", async () => {
		reply = () => Response.json({ ok: true });
		const { response, model } = await postInteraction(
			config,
			{ model: GEMINI_VISION_MODEL, store: false },
			signal(),
		);
		expect(model).toBe(GEMINI_VISION_MODEL);
		expect(await response.json()).toEqual({ ok: true });
		expect(sent).toEqual([
			{
				path: "/v1beta/interactions",
				method: "POST",
				key: "test-gemini-key",
				body: { model: GEMINI_VISION_MODEL, store: false },
			},
		]);
	});

	test.each([429, 503])(
		"an overloaded primary (HTTP %i) is sent again on the fallback model",
		async (status) => {
			reply = (model) =>
				model === GEMINI_VISION_MODEL
					? new Response("high demand", { status })
					: Response.json({ from: model });
			const { response, model } = await postInteraction(
				config,
				{ model: GEMINI_VISION_MODEL, store: false },
				signal(),
			);
			expect(model).toBe(GEMINI_FALLBACK_MODEL);
			expect(await response.json()).toEqual({ from: GEMINI_FALLBACK_MODEL });
			expect(sent.map(({ body }) => body)).toEqual([
				{ model: GEMINI_VISION_MODEL, store: false },
				{ model: GEMINI_FALLBACK_MODEL, store: false },
			]);
		},
	);

	test.each([400, 401, 500])(
		"HTTP %i is not an overload and returns without a retry",
		async (status) => {
			reply = () => new Response("error", { status });
			const { response, model } = await postInteraction(
				config,
				{ model: GEMINI_VISION_MODEL },
				signal(),
			);
			expect(response.status).toBe(status);
			expect(model).toBe(GEMINI_VISION_MODEL);
			expect(sent).toHaveLength(1);
		},
	);

	test("a call already on the fallback model is not sent again", async () => {
		reply = () => new Response("high demand", { status: 503 });
		const { response, model } = await postInteraction(
			config,
			{ model: GEMINI_FALLBACK_MODEL },
			signal(),
		);
		expect(response.status).toBe(503);
		expect(model).toBe(GEMINI_FALLBACK_MODEL);
		expect(sent).toHaveLength(1);
	});

	test("when both models are overloaded, the fallback's refusal is returned", async () => {
		reply = () => new Response("high demand", { status: 429 });
		const { response, model } = await postInteraction(
			config,
			{ model: GEMINI_VISION_MODEL },
			signal(),
		);
		expect(response.status).toBe(429);
		expect(model).toBe(GEMINI_FALLBACK_MODEL);
		expect(sent.map(({ body }) => body.model)).toEqual([
			GEMINI_VISION_MODEL,
			GEMINI_FALLBACK_MODEL,
		]);
	});
});

describe("createGeminiDetector", () => {
	const image = { type: "image/png", data: "iVBORw0KGgo=" } as const;
	const detect = (
		overrides: Partial<Parameters<typeof createGeminiDetector>[0]> = {},
	) => createGeminiDetector({ ...config, ...overrides })(image);
	const failure = (overrides = {}) =>
		Effect.runPromise(Effect.flip(detect(overrides)));

	test("sends the image with a JSON schema and store off, and reads the boxes", async () => {
		reply = () =>
			detections([
				{
					box_2d: [10, 20, 300, 400],
					category: "keys",
					label: " car keys ",
					label_readable: false,
					confidence: 0.9,
				},
				{
					box_2d: [10, 20, 300, 400],
					category: "medicine",
					label: "  Ibuprofen 200 mg ",
					label_readable: true,
					confidence: 0.9,
				},
				{
					box_2d: [0, 0, 1000, 1000],
					category: "medicine",
					label: "Aspirin",
					label_readable: false,
					confidence: 0.4,
				},
				{
					box_2d: [5, 5, 6, 6],
					category: "glasses",
					label: "   ",
					label_readable: true,
					confidence: 1,
				},
			]);
		const result = await Effect.runPromise(detect());
		// The main object keeps its place first. Only medicine needs a readable printed name.
		expect(result).toEqual({
			model: GEMINI_VISION_MODEL,
			boxes: [
				{
					box: [10, 20, 300, 400],
					category: "keys",
					label: "car keys",
					confidence: 0.9,
				},
				{
					box: [10, 20, 300, 400],
					category: "medicine",
					label: "Ibuprofen 200 mg",
					confidence: 0.9,
				},
				{
					box: [0, 0, 1000, 1000],
					category: "medicine",
					label: null,
					confidence: 0.4,
				},
				{ box: [5, 5, 6, 6], category: "glasses", label: null, confidence: 1 },
			],
			landmarks: [],
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]?.key).toBe("test-gemini-key");
		expect(sent[0]?.body).toMatchObject({
			model: GEMINI_VISION_MODEL,
			store: false,
			input: [
				{ type: "text" },
				{ type: "image", mime_type: "image/png", data: image.data },
			],
			response_format: {
				type: "text",
				mime_type: "application/json",
				schema: { required: ["detections"] },
			},
		});
	});

	test("an empty list is a valid answer with no boxes", async () => {
		reply = () => detections([]);
		expect((await Effect.runPromise(detect())).boxes).toEqual([]);
	});

	test("an overloaded primary answers from the fallback model", async () => {
		reply = (model) =>
			model === GEMINI_VISION_MODEL
				? new Response("high demand", { status: 503 })
				: detections([]);
		expect(await Effect.runPromise(detect())).toEqual({
			boxes: [],
			landmarks: [],
			model: GEMINI_FALLBACK_MODEL,
		});
	});

	test.each([429, 503, 500, 401])(
		"HTTP %i from every model is a typed http failure with that status",
		async (status) => {
			reply = () => new Response("detail AIza-secret", { status });
			const error = await failure();
			expect(error._tag).toBe("VisionUpstreamError");
			expect(error.reason).toBe("http");
			expect(error.status).toBe(status);
		},
	);

	const box = {
		box_2d: [10, 10, 20, 20],
		category: "keys",
		label: "x",
		label_readable: true,
		confidence: 0.5,
	};
	test.each<[string, () => Response]>([
		["a non-JSON body", () => new Response("<html>")],
		["an interaction outside the schema", () => Response.json({ steps: 1 })],
		["an unfinished interaction", () => interaction("{}", "failed")],
		["model text that is not JSON", () => interaction("I see a box")],
		["a missing detections list", () => interaction("{}")],
		[
			"a coordinate above 1000",
			() => detections([{ ...box, box_2d: [0, 0, 1001, 10] }]),
		],
		["a confidence above 1", () => detections([{ ...box, confidence: 1.5 }])],
		[
			"a category outside the list",
			() => detections([{ ...box, category: "sofa" }]),
		],
		[
			"an inverted box",
			() => detections([{ ...box, box_2d: [20, 10, 10, 20] }]),
		],
		["an empty box", () => detections([{ ...box, box_2d: [10, 10, 20, 10] }])],
		[
			"no model output step",
			() =>
				Response.json({ status: "completed", steps: [{ type: "thought" }] }),
		],
	])("%s is an invalid_response", async (_, make) => {
		reply = make;
		const error = await failure();
		expect(error._tag).toBe("VisionUpstreamError");
		expect(error.reason).toBe("invalid_response");
	});

	test("an unreachable provider is a network failure", async () => {
		const baseUrl = "http://127.0.0.1:1";
		expect((await failure({ baseUrl })).reason).toBe("network");
	});

	test("a provider that never answers fails with timeout after the limit", async () => {
		reply = () => new Promise<Response>(() => {});
		const started = Date.now();
		const error = await failure({ timeout: 100 });
		expect(error.reason).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
