// A local protocol server stands in for the Gemini Interactions API. Test key and synthetic meals
// only: local protocol proof, not a live estimate.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { MealEstimateRequest } from "@health/contracts/meal-facts";
import { ApiFailure } from "../http";
import { estimateMeal, GEMINI_MEAL_MODEL } from "./gemini-meal";

type Body = {
	model: string;
	store: boolean;
	input: { type: string; text?: string; mime_type?: string; data?: string }[];
	response_format: { mime_type: string; schema: { required: string[] } };
};
const sent: { path: string; key: string | null; body: Body }[] = [];
let reply: (request: Request) => Response | Promise<Response>;
const server = Bun.serve({
	port: 0,
	fetch: async (request) => {
		sent.push({
			path: new URL(request.url).pathname,
			key: request.headers.get("x-goog-api-key"),
			body: (await request.clone().json()) as Body,
		});
		return reply(request);
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	sent.length = 0;
});

const config = { apiKey: "test-gemini-key", baseUrl: server.url.origin };

const item = {
	name: "Rice",
	preparation: "boiled",
	portion: "about 1 cup",
	energy_kcal: [200, 250],
	protein_g: [4, 5],
	carbohydrate_g: [45, 50],
	fat_g: [0, 1],
};
const interaction = (text: string, status = "completed") =>
	Response.json({
		status,
		steps: [
			{ type: "thought", content: [{ text: "ignored" }] },
			{ type: "model_output", content: [{ text }, {}] },
		],
	});
const items = (list: unknown[]) => interaction(JSON.stringify({ items: list }));

const photo: MealEstimateRequest = {
	source: "photo",
	capturedAt: "2026-10-04T12:00:00.000Z",
	image: { type: "image/jpeg", data: "/9j/4AAQ" },
};
const estimate = (
	request: MealEstimateRequest = photo,
	signal = new AbortController().signal,
	overrides = {},
) => estimateMeal({ ...config, ...overrides }, request, signal);
const failure = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(error).toBeInstanceOf(ApiFailure);
	return error as ApiFailure;
};

describe("estimateMeal", () => {
	test("sends the photo with a JSON schema and store off, and reads ranges", async () => {
		reply = () =>
			items([
				{ ...item, energy_kcal: [250, 200] },
				{
					...item,
					name: "   ",
					preparation: "  ",
					portion: "",
				},
				{ ...item, name: ` ${"n".repeat(130)}`, portion: " 2 slices " },
			]);
		const result = await estimate();
		expect(result).toEqual([
			{
				name: "Rice",
				preparation: "boiled",
				portion: "about 1 cup",
				energyKcal: { low: 200, high: 250 },
				proteinG: { low: 4, high: 5 },
				carbohydrateG: { low: 45, high: 50 },
				fatG: { low: 0, high: 1 },
			},
			expect.objectContaining({
				name: "Food not clear",
				preparation: null,
				portion: "Portion not clear",
			}),
			expect.objectContaining({ name: "n".repeat(120), portion: "2 slices" }),
		]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.path).toBe("/v1beta/interactions");
		expect(sent[0]?.key).toBe("test-gemini-key");
		const body = sent[0]?.body;
		expect(body).toMatchObject({
			model: GEMINI_MEAL_MODEL,
			store: false,
			response_format: {
				mime_type: "application/json",
				schema: { required: ["items"] },
			},
		});
		expect(body?.input[0]?.text).toEndWith("The meal is in the photo.");
		expect(body?.input[1]).toEqual({
			type: "image",
			mime_type: "image/jpeg",
			data: "/9j/4AAQ",
		});
	});

	test("a description goes as quoted text with no image", async () => {
		reply = () => items([]);
		expect(
			await estimate({ source: "description", text: 'Toast "with" jam' }),
		).toEqual([]);
		const input = sent[0]?.body.input;
		expect(input).toHaveLength(1);
		expect(input?.[0]?.text).toContain(
			`The wearer described the meal: ${JSON.stringify('Toast "with" jam')}`,
		);
	});

	const corrected = [
		{ name: "Brown rice", preparation: null, portion: "half a cup" },
		{ name: "Egg", preparation: "fried", portion: "1 egg" },
	];
	test("a correction keeps the wearer's foods and takes only the ranges", async () => {
		reply = () =>
			items([
				{ ...item, name: "White rice" },
				{ ...item, name: "Omelette", fat_g: [9, 7] },
			]);
		const result = await estimate({ source: "correction", items: corrected });
		expect(result).toEqual([
			expect.objectContaining({ ...corrected[0], fatG: { low: 0, high: 1 } }),
			expect.objectContaining({ ...corrected[1], fatG: { low: 7, high: 9 } }),
		]);
		expect(sent[0]?.body.input[0]?.text).toContain(JSON.stringify(corrected));
	});

	test("a correction answered with a different number of foods fails", async () => {
		reply = () => items([item]);
		const error = await failure(
			estimate({ source: "correction", items: corrected }),
		);
		expect(error.code).toBe("upstream_error");
		expect(error.message).toContain("changed the corrected food list");
	});

	test.each([429, 500, 503])(
		"HTTP %i is an upstream_error with the status and no provider text",
		async (status) => {
			reply = () => new Response("detail test-gemini-key", { status });
			const error = await failure(estimate());
			expect(error.code).toBe("upstream_error");
			expect(error.message).toBe(
				`The meal estimator failed with HTTP ${status}`,
			);
		},
	);

	test.each<[string, () => Response]>([
		["a non-JSON body", () => new Response("<html>")],
		["an interaction outside the schema", () => Response.json({ status: 1 })],
		["an unfinished interaction", () => interaction("{}", "in_progress")],
		["model text that is not JSON", () => interaction("Rice, 200 kcal")],
		["a missing field", () => items([{ ...item, fat_g: undefined }])],
		["a negative amount", () => items([{ ...item, protein_g: [-1, 2] }])],
		[
			"a non-finite amount",
			// A full valid item whose only defect is energy_kcal: JSON parses 1e999 as Infinity.
			() =>
				interaction(
					JSON.stringify({ items: [item] }).replace(
						'"energy_kcal":[200,250]',
						'"energy_kcal":[1e999,250]',
					),
				),
		],
	])("%s is an invalid reply", async (_, make) => {
		reply = make;
		const error = await failure(estimate());
		expect(error.code).toBe("upstream_error");
		expect(error.message).toBe("The meal estimator sent an invalid reply");
	});

	test("an unreachable estimator is an upstream_error", async () => {
		const baseUrl = "http://127.0.0.1:1";
		const error = await failure(
			estimate(photo, new AbortController().signal, { baseUrl }),
		);
		expect(error.message).toBe("The meal estimator could not be reached");
	});

	test("an estimator slower than the limit times out and is aborted", async () => {
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		reply = (request) => {
			request.signal.addEventListener("abort", () => resolve());
			return new Promise<Response>(() => {});
		};
		const error = await failure(
			estimate(photo, new AbortController().signal, { timeout: 50 }),
		);
		expect(error.code).toBe("upstream_error");
		expect(error.message).toBe("The meal estimate timed out");
		await aborted;
	});

	test("aborting the caller's signal aborts the provider call", async () => {
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		reply = (request) => {
			request.signal.addEventListener("abort", () => resolve());
			arrive();
			return new Promise<Response>(() => {});
		};
		const controller = new AbortController();
		const pending = failure(estimate(photo, controller.signal));
		await arrived;
		controller.abort();
		expect((await pending).code).toBe("upstream_error");
		await aborted;
	});
});
