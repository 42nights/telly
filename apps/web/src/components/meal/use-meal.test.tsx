import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type { Meal, MealEstimate } from "@health/contracts/meal-facts";
import {
	act,
	installDom,
	type Reply,
	renderHook,
	serve,
	waitFor,
} from "../test/dom";

import { transcribe, useMeal } from "./use-meal";

installDom();

const estimate: MealEstimate = {
	basis: "estimate",
	source: "description",
	estimator: "model-x",
	estimatedAt: "2026-10-04T08:00:00.000Z",
	items: [
		{
			name: "Rice",
			preparation: "boiled",
			portion: "1 cup",
			energyKcal: { low: 200, high: 240 },
			proteinG: { low: 4, high: 5 },
			carbohydrateG: { low: 44, high: 50 },
			fatG: { low: 0, high: 1 },
		},
	],
};

const meal = (mealId: string): Meal => ({
	mealId,
	intake: "reported",
	facts: [
		{
			id: "1",
			fact: {
				type: "intake_report",
				kind: "meal",
				amount: "some",
				reportedBy: "wearer",
				words: null,
				via: "tap",
			},
			recordedBy: "a".repeat(64),
			recordedAt: "2026-10-04T08:05:00.000Z",
		},
	],
});

const estimatePath = (mealId: string) =>
	`/api/families/f1/meals/${mealId}/estimates`;

/** A reply the test sends later, so the request stays in flight until then. */
const deferred = () => {
	let resolve: (reply: Reply) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<Reply>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
};

describe("transcribe", () => {
	test("sends the recording with its own type and gives back the trimmed words", async () => {
		const calls = serve({
			"POST /api/families/f1/voice/transcriptions": {
				json: {
					text: "  rice and dal ",
					languageCode: "en",
					languageProbability: 0.9,
				},
			},
		});
		const audio = new Blob(["x"], { type: "audio/ogg" });
		expect(await transcribe("f1", audio)).toEqual({
			kind: "ready",
			value: "rice and dal",
		});
		expect(calls.map((call) => [call.method, call.path])).toEqual([
			["POST", "/api/families/f1/voice/transcriptions"],
		]);
		expect(calls[0]?.body).toBe(audio);
	});

	test("labels an untyped recording as audio/webm", async () => {
		serve({
			"POST /api/families/f1/voice/transcriptions": {
				json: { text: "hi", languageCode: "en", languageProbability: 1 },
			},
		});
		const sent: string[] = [];
		const served = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(new Headers(init?.headers).get("Content-Type") ?? "");
			return served(input, init);
		}) as typeof fetch;
		await transcribe("f1", new Blob(["x"]));
		expect(sent).toEqual(["audio/webm"]);
	});

	test("passes a failure through unchanged", async () => {
		serve({
			"POST /api/families/f1/voice/transcriptions": { status: 401 },
		});
		expect(await transcribe("f1", new Blob(["x"]))).toEqual({
			kind: "signed_out",
		});
	});
});

describe("useMeal", () => {
	test("says no person is paired, and sends nothing, without a family", async () => {
		const calls = serve({});
		const { result } = renderHook(() => useMeal(null));
		await act(() =>
			result.current.estimateFrom({ source: "description", text: "rice" }),
		);
		await act(() =>
			result.current.reportIntake(
				{ type: "caregiver_assistance", help: "cut" },
				"help: cut",
			),
		);
		const noFamily = {
			kind: "error",
			message: "No person is paired yet.",
		} as const;
		expect(result.current.estimate).toEqual(noFamily);
		expect(result.current.report).toEqual(noFamily);
		expect(calls).toEqual([]);
	});

	test("estimates a described meal: estimating, then the estimate", async () => {
		const { result } = renderHook(() => useMeal("f1"));
		const { mealId } = result.current;
		expect(mealId).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.current.estimate).toEqual({ kind: "idle" });
		const reply = deferred();
		const calls = serve({
			[`POST ${estimatePath(mealId)}`]: () => reply.promise,
		});
		let done: Promise<void> = Promise.resolve();
		act(() => {
			done = result.current.estimateFrom({
				source: "description",
				text: "rice",
			});
		});
		expect(result.current.estimate).toEqual({ kind: "estimating" });
		reply.resolve({ json: estimate });
		await act(() => done);
		expect(result.current.estimate).toEqual({ kind: "done", estimate });
		expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
			["POST", estimatePath(mealId), { source: "description", text: "rice" }],
		]);
	});

	test("shows the server's failure in place of an estimate", async () => {
		const { result } = renderHook(() => useMeal("f1"));
		const calls = serve({
			[`POST ${estimatePath(result.current.mealId)}`]: {
				status: 503,
				body: { error: "unavailable", message: "No estimator" },
			},
		});
		await act(() =>
			result.current.estimateFrom({ source: "description", text: "rice" }),
		);
		expect(result.current.estimate).toEqual({
			kind: "unavailable",
			message: "No estimator",
		});
		expect(calls[0]?.body).toEqual({ source: "description", text: "rice" });
	});

	test("a newer estimate replaces one still in flight", async () => {
		const { result } = renderHook(() => useMeal("f1"));
		const first = deferred();
		const second = deferred();
		const replies = [first, second];
		const calls = serve({
			[`POST ${estimatePath(result.current.mealId)}`]: () => {
				const next = replies.shift();
				if (next === undefined) throw new Error("unexpected estimate");
				return next.promise;
			},
		});
		let one: Promise<void> = Promise.resolve();
		let two: Promise<void> = Promise.resolve();
		act(() => {
			one = result.current.estimateFrom({
				source: "description",
				text: "rice",
			});
		});
		await waitFor(() => expect(calls.length).toBe(1));
		act(() => {
			two = result.current.estimateFrom({ source: "description", text: "dal" });
		});
		await waitFor(() => expect(calls.length).toBe(2));
		second.resolve({ json: { ...estimate, estimator: "second" } });
		await act(() => two);
		// The first reply arrives late and is ignored.
		first.resolve({ json: { ...estimate, estimator: "first" } });
		await act(() => one);
		expect(result.current.estimate).toEqual({
			kind: "done",
			estimate: { ...estimate, estimator: "second" },
		});
	});

	test("a new meal drops the estimate in flight and starts empty", async () => {
		const { result } = renderHook(() => useMeal("f1"));
		const firstId = result.current.mealId;
		const reply = deferred();
		const calls = serve({
			[`POST ${estimatePath(firstId)}`]: () => reply.promise,
			[`POST /api/families/f1/meals/${firstId}/intake`]: {
				json: meal(firstId),
			},
		});
		await act(() =>
			result.current.reportIntake(
				{
					type: "intake_report",
					kind: "meal",
					amount: "some",
					words: null,
					reportedBy: "wearer",
					via: "tap",
				},
				"some",
			),
		);
		let pending: Promise<void> = Promise.resolve();
		act(() => {
			pending = result.current.estimateFrom({
				source: "description",
				text: "x",
			});
		});
		await waitFor(() => expect(calls.length).toBe(2));
		act(() => result.current.newMeal());
		expect(result.current.mealId).not.toBe(firstId);
		expect(result.current.photo).toBeNull();
		expect(result.current.estimate).toEqual({ kind: "idle" });
		expect(result.current.report).toEqual({ kind: "idle" });
		// The dropped request fails after its abort; the new meal stays empty.
		reply.reject(new Error("aborted"));
		await act(() => pending);
		expect(result.current.estimate).toEqual({ kind: "idle" });
	});

	test("unmounting aborts the estimate in flight", async () => {
		const { result, unmount } = renderHook(() => useMeal("f1"));
		const calls = serve({
			[`POST ${estimatePath(result.current.mealId)}`]: () =>
				new Promise<Reply>(() => {}),
		});
		const signals: (AbortSignal | null | undefined)[] = [];
		const served = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			signals.push(init?.signal);
			return served(input, init);
		}) as typeof fetch;
		act(() => {
			void result.current.estimateFrom({ source: "description", text: "x" });
		});
		await waitFor(() => expect(calls.length).toBe(1));
		expect(signals[0]?.aborted).toBe(false);
		unmount();
		expect(signals[0]?.aborted).toBe(true);
	});

	test("reports intake: saving, then saved with what the screen confirms", async () => {
		const { result } = renderHook(() => useMeal("f1"));
		const { mealId } = result.current;
		const reply = deferred();
		const calls = serve({
			[`POST /api/families/f1/meals/${mealId}/intake`]: () => reply.promise,
		});
		const body = {
			type: "caregiver_assistance",
			help: "cut the food",
		} as const;
		let done: Promise<void> = Promise.resolve();
		act(() => {
			done = result.current.reportIntake(body, "help: cut the food");
		});
		expect(result.current.report).toEqual({ kind: "saving" });
		reply.resolve({ json: meal(mealId) });
		await act(() => done);
		expect(result.current.report).toEqual({
			kind: "saved",
			meal: meal(mealId),
			saved: "help: cut the food",
		});
		expect(calls[0]?.body).toEqual(body);
	});

	test("a refused report shows the failure", async () => {
		const { result } = renderHook(() => useMeal("f1"));
		serve({
			[`POST /api/families/f1/meals/${result.current.mealId}/intake`]: {
				status: 403,
				body: { error: "forbidden", message: "Not a member" },
			},
		});
		await act(() =>
			result.current.reportIntake(
				{ type: "caregiver_assistance", help: "cut" },
				"help: cut",
			),
		);
		expect(result.current.report).toEqual({
			kind: "forbidden",
			message: "Not a member",
		});
	});

	describe("takePhoto", () => {
		let restore = () => {};
		beforeEach(() => {
			const { getContext, toDataURL } = HTMLCanvasElement.prototype;
			restore = () =>
				Object.assign(HTMLCanvasElement.prototype, { getContext, toDataURL });
		});
		afterEach(() => {
			restore();
			setSystemTime();
		});

		const video = (width: number, height: number) => {
			const element = document.createElement("video");
			Object.defineProperty(element, "videoWidth", { value: width });
			Object.defineProperty(element, "videoHeight", { value: height });
			return element;
		};

		test("shows the frame and sends it for an estimate", async () => {
			setSystemTime(new Date("2026-10-04T08:00:00.000Z"));
			Object.assign(HTMLCanvasElement.prototype, {
				getContext: () => ({ drawImage: () => {} }),
				toDataURL: () => "data:image/jpeg;base64,AAAA",
			});
			const { result } = renderHook(() => useMeal("f1"));
			const calls = serve({
				[`POST ${estimatePath(result.current.mealId)}`]: {
					json: { ...estimate, source: "photo" },
				},
			});
			act(() => result.current.takePhoto(video(640, 480)));
			expect(result.current.photo).toBe("data:image/jpeg;base64,AAAA");
			await waitFor(() => expect(result.current.estimate.kind).toBe("done"));
			expect(calls[0]?.body).toEqual({
				source: "photo",
				capturedAt: "2026-10-04T08:00:00.000Z",
				image: { type: "image/jpeg", data: "AAAA" },
			});
		});

		test("does nothing without a camera or a frame", () => {
			const calls = serve({});
			const { result } = renderHook(() => useMeal("f1"));
			act(() => result.current.takePhoto(null));
			act(() => result.current.takePhoto(video(0, 0)));
			expect(result.current.photo).toBeNull();
			expect(result.current.estimate).toEqual({ kind: "idle" });
			expect(calls).toEqual([]);
		});
	});
});
