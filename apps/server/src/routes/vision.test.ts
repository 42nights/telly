import { afterAll, describe, expect, test } from "bun:test";
import { crc32, deflateSync } from "node:zlib";
import { ApiError } from "@health/contracts";
import { MedicineDetections, type VisionFrame } from "@health/contracts/vision";
import { Schema } from "effect";
import { Hono } from "hono";
import { ApiFailure, errorStatus } from "../http";
import {
	GEMINI_FALLBACK_MODEL,
	GEMINI_VISION_MODEL,
	type GeminiConfig,
} from "../integrations/gemini";
import { imageSize, toFramePixels, visionRoutes } from "./vision";

// Synthetic test frames only: a flat gray PNG and a header-only JPEG. No real camera image.
const png = (width: number, height: number) => {
	const chunk = (type: string, data: Buffer) => {
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		out.write(type, 4, "latin1");
		data.copy(out, 8);
		out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // RGB
	const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
	for (let row = 0; row < height; row++) rows[row * (width * 3 + 1)] = 0;
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
};

const frame: VisionFrame = {
	id: "synthetic-frame-1",
	capturedAt: "2026-10-04T12:00:00.000Z",
	width: 1000,
	height: 800,
	crop: { x: 100, y: 50, width: 400, height: 200 },
	rotation: 90,
};
// Rotated 90°, the 400×200 crop is 200 wide and 400 tall; the client scaled it by half.
const body = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		frame,
		image: { type: "image/png", data: png(100, 200).toString("base64") },
		...overrides,
	});

// Local protocol server standing in for the Interactions API. It is not a live Gemini call.
type Reply = (request: Request) => Response | Promise<Response>;
let reply: Reply = () => new Response(null, { status: 500 });
let lastRequest: { headers: Headers; json: unknown } | undefined;
const gemini = Bun.serve({
	port: 0,
	fetch: async (request) => {
		lastRequest = {
			headers: request.headers,
			json: await request.clone().json(),
		};
		return reply(request);
	},
});
afterAll(() => gemini.stop(true));

const interaction = (text: string, status = "completed") =>
	Response.json({
		id: "v1_synthetic",
		status,
		steps: [{ type: "model_output", content: [{ type: "text", text }] }],
	});

// The app's onError turns a thrown ApiFailure into its typed body; the bare route needs the same.
const mount = (gemini: GeminiConfig | undefined) =>
	new Hono().route("/", visionRoutes(gemini)).onError((failure, c) => {
		if (!(failure instanceof ApiFailure)) throw failure;
		return c.json(
			{ error: failure.code, message: failure.message },
			errorStatus[failure.code],
		);
	});
const routesWithTimeout = (timeout: number) =>
	mount({ apiKey: "test-key-not-a-secret", baseUrl: gemini.url.href, timeout });
// Real clock on purpose: the slow-provider case exercises the actual timeout.
const routes = routesWithTimeout(200);
const post = (payload: string, signal?: AbortSignal, app = routes) =>
	app.request("/medicine-detections", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: payload,
		...(signal ? { signal } : {}),
	});
const errorOf = async (response: Response) =>
	Schema.decodeUnknownSync(ApiError)(await response.json());

describe("medicine detection route", () => {
	test("answers unavailable without a Gemini key, never an empty result", async () => {
		const response = await post(body(), undefined, mount(undefined));
		expect(response.status).toBe(503);
		expect((await errorOf(response)).error).toBe("unavailable");
	});

	test.each([
		["malformed JSON", "{"],
		["unknown rotation", body({ frame: { ...frame, rotation: 45 } })],
		[
			"crop outside the frame",
			body({ frame: { ...frame, crop: { ...frame.crop, x: 700 } } }),
		],
		[
			"PNG bytes declared as JPEG",
			body({
				image: { type: "image/jpeg", data: png(100, 200).toString("base64") },
			}),
		],
		[
			"image not matching the rotated crop",
			body({
				image: { type: "image/png", data: png(200, 100).toString("base64") },
			}),
		],
	])("rejects %s without calling Gemini", async (_name, payload) => {
		lastRequest = undefined;
		const response = await post(payload);
		expect(response.status).toBe(400);
		expect((await errorOf(response)).error).toBe("invalid_request");
		expect(lastRequest).toBeUndefined();
	});

	test("rejects an oversized body before parsing it", async () => {
		const response = await post(
			body({ image: { type: "image/png", data: "A".repeat(6 * 1024 * 1024) } }),
		);
		expect(response.status).toBe(400);
		expect((await errorOf(response)).error).toBe("invalid_request");
	});

	test("maps Gemini boxes back to the frame they were found in", async () => {
		reply = () =>
			interaction(
				JSON.stringify({
					detections: [
						{
							box_2d: [0, 0, 250, 500],
							label: " Metformin ",
							label_readable: true,
							confidence: 0.9,
						},
						{
							box_2d: [500, 500, 1000, 1000],
							label: "",
							label_readable: false,
							confidence: 0.95,
						},
						{
							box_2d: [10, 10, 20, 20],
							label: "Aspirin",
							label_readable: true,
							confidence: 0.4,
						},
					],
				}),
			);
		const response = await post(body());
		expect(response.status).toBe(200);
		const result = Schema.decodeUnknownSync(MedicineDetections)(
			await response.json(),
			{ onExcessProperty: "error" },
		);
		expect(result.frame).toEqual(frame);
		expect(result.model).toBe(GEMINI_VISION_MODEL);
		expect(
			result.detections.map((d) => [d.label, d.needsVerification]),
		).toEqual([
			["Metformin", false],
			[null, true],
			["Aspirin", true],
		]);
		expect(result.detections[0]?.box).toEqual({
			x: 100,
			y: 150,
			width: 100,
			height: 100,
		});

		// The key stays in a server-to-provider header, and Google is told not to store the frame.
		expect(lastRequest?.headers.get("x-goog-api-key")).toBe(
			"test-key-not-a-secret",
		);
		expect(lastRequest?.json).toMatchObject({
			model: GEMINI_VISION_MODEL,
			store: false,
			input: [{ type: "text" }, { type: "image", mime_type: "image/png" }],
		});
	});

	test("falls back to the steadier model when the primary one is overloaded", async () => {
		reply = async (request) =>
			((await request.json()) as { model: string }).model ===
			GEMINI_VISION_MODEL
				? new Response(null, { status: 503 })
				: interaction(JSON.stringify({ detections: [] }));
		const response = await post(body());
		expect(response.status).toBe(200);
		const result = Schema.decodeUnknownSync(MedicineDetections)(
			await response.json(),
			{ onExcessProperty: "error" },
		);
		expect(result.model).toBe(GEMINI_FALLBACK_MODEL);
		expect(lastRequest?.json).toMatchObject({ model: GEMINI_FALLBACK_MODEL });
	});

	test("falls back when the primary model is too slow, within the same budget", async () => {
		const primaryCut = Promise.withResolvers<void>();
		const Sent = Schema.Struct({ model: Schema.String });
		reply = async (request) => {
			const { model } = Schema.decodeUnknownSync(Sent)(await request.json());
			if (model === GEMINI_FALLBACK_MODEL)
				return interaction(JSON.stringify({ detections: [] }));
			request.signal.addEventListener("abort", () => primaryCut.resolve());
			return new Promise<Response>(() => {});
		};
		const response = await post(body());
		expect(response.status).toBe(200);
		expect(
			Schema.decodeUnknownSync(MedicineDetections)(await response.json()).model,
		).toBe(GEMINI_FALLBACK_MODEL);
		// The slow primary request was closed, not left running.
		await primaryCut.promise;
	});

	const failed = "Medicine detection failed";
	const busy = "The picture checker is busy right now";
	test.each<[string, Reply, string]>([
		[
			"an overloaded provider",
			() => new Response("quota exceeded for key AIza-secret", { status: 429 }),
			busy,
		],
		[
			"an HTTP error",
			() => new Response("internal detail AIza-secret", { status: 500 }),
			failed,
		],
		["a failed interaction", () => interaction("{}", "failed"), failed],
		["non-JSON model text", () => interaction("I see a box"), failed],
		[
			"an inverted box",
			() =>
				interaction(
					JSON.stringify({
						detections: [
							{
								box_2d: [500, 0, 100, 10],
								label: "x",
								label_readable: true,
								confidence: 1,
							},
						],
					}),
				),
			failed,
		],
		[
			"a slow provider",
			() => new Promise<Response>(() => {}),
			"The picture checker is busy right now and did not answer in time",
		],
	])(
		"reports %s as upstream_error without provider text",
		async (_name, next, message) => {
			reply = next;
			const response = await post(body());
			expect(response.status).toBe(502);
			const error = await errorOf(response);
			expect(error.error).toBe("upstream_error");
			expect(error.message).toStartWith(message);
			expect(error.message).not.toContain("AIza");
		},
	);

	test("aborts the Gemini call when the client disconnects", async () => {
		const client = new AbortController();
		const providerAborted = new Promise<void>((resolve) => {
			reply = (request) => {
				request.signal.addEventListener("abort", () => resolve());
				client.abort();
				return new Promise<Response>(() => {});
			};
		});
		// The provider timeout outlasts the test, so only the client abort can end the call.
		await Promise.resolve(
			post(body(), client.signal, routesWithTimeout(60_000)),
		).catch(() => undefined);
		// Resolves only when the provider sees the abort; otherwise the test times out.
		await providerAborted;
	});
});

describe("frame mapping", () => {
	const crop = { x: 100, y: 50, width: 400, height: 200 };
	test.each([
		[0, { x: 100, y: 50, width: 200, height: 50 }],
		[90, { x: 100, y: 150, width: 100, height: 100 }],
		[180, { x: 300, y: 200, width: 200, height: 50 }],
		[270, { x: 400, y: 50, width: 100, height: 100 }],
	] as const)("undoes a %i° rotation and the crop", (rotation, expected) => {
		expect(
			toFramePixels({ ...frame, crop, rotation }, [0, 0, 250, 500]),
		).toEqual(expected);
	});

	test("reads the size from a JPEG frame header after other segments", () => {
		const jpeg = Buffer.from(
			"ffd8" +
				"ffe000104a46494600010100000100010000" +
				"ffc2001108" +
				"01e0" +
				"0280" +
				"03012200021101031101",
			"hex",
		);
		expect(imageSize("image/jpeg", jpeg)).toEqual({ width: 640, height: 480 });
	});
});
