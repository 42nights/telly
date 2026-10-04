import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	setSystemTime,
	test,
} from "bun:test";
import type { FamilyList } from "@health/contracts/families";
import {
	MAX_VISION_IMAGE_BYTES,
	type MedicineDetection,
	MedicineDetectionRequest,
} from "@health/contracts/vision";
import { Schema } from "effect";
import type { ApiState } from "@/lib/api";
import {
	act,
	type Call,
	installDom,
	renderHook,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import {
	bestDetection,
	type CheckResult,
	capture,
	usePictureCheck,
} from "./medicine-check";

installDom();

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const detectionsPath = "POST /api/families/f1/vision/medicine-detections";

/**
 * The brightness each video or canvas shows. A canvas takes the brightness of what is drawn on it;
 * one with nothing drawn reads as transparent (no frame).
 */
const shade = new WeakMap<object, number>();
let saved: { getContext: unknown; toDataURL: unknown };

beforeEach(() => {
	setSystemTime(NOW);
	const proto = HTMLCanvasElement.prototype;
	saved = { getContext: proto.getContext, toDataURL: proto.toDataURL };
	Object.assign(proto, {
		getContext(this: HTMLCanvasElement) {
			return {
				drawImage: (source: object) => {
					const s = shade.get(source);
					if (s !== undefined) shade.set(this, s);
				},
				getImageData: (_x: number, _y: number, w: number, h: number) => {
					const s = shade.get(this);
					const data = new Uint8ClampedArray(w * h * 4);
					// The left half lit, so the brightness survives cell averaging and mean removal.
					for (let i = 0; i < w * h; i++) {
						data.fill(i % w < w / 2 ? (s ?? 0) : 0, i * 4, i * 4 + 3);
						data[i * 4 + 3] = s === undefined ? 0 : 255;
					}
					return { data };
				},
			};
		},
		// One base64 character per pixel, so a big frame must be scaled down to fit.
		toDataURL(this: HTMLCanvasElement) {
			return `data:image/jpeg;base64,${"A".repeat(this.width * this.height)}`;
		},
	});
});

afterEach(() => {
	jest.useRealTimers();
	setSystemTime();
	Object.assign(HTMLCanvasElement.prototype, saved);
});

const video = (width: number, height: number, brightness?: number) => {
	const v = document.createElement("video");
	Object.defineProperties(v, {
		videoWidth: { value: width },
		videoHeight: { value: height },
		readyState: { value: HTMLMediaElement.HAVE_ENOUGH_DATA },
	});
	if (brightness !== undefined) shade.set(v, brightness);
	return v;
};

const detection = (confidence: number): MedicineDetection => ({
	label: `conf ${confidence}`,
	confidence,
	needsVerification: confidence < 0.7,
	box: { x: 1, y: 2, width: 3, height: 4 },
});

/** Answers a detection request for the frame it was sent, or for `frameId` when given. */
const detected =
	(detections: MedicineDetection[], frameId?: string) =>
	(call: Call): ServerReply => {
		const { frame } = Schema.decodeUnknownSync(MedicineDetectionRequest)(
			call.body,
		);
		return {
			json: {
				frame: { ...frame, id: frameId ?? frame.id },
				detections,
				model: "vision-1",
				analyzedAt: "2026-10-04T12:00:01Z",
			},
		};
	};

const ready: ApiState<FamilyList> = {
	kind: "ready",
	value: { families: [] },
	at: NOW,
};

describe("capture", () => {
	test("gives nothing while the video has no frame", () => {
		expect(capture(video(0, 0, 10))).toBeNull();
		expect(capture(video(640, 0, 10))).toBeNull();
	});

	test("gives nothing when the browser has no 2D canvas", () => {
		Object.assign(HTMLCanvasElement.prototype, { getContext: () => null });
		expect(capture(video(640, 480, 10))).toBeNull();
	});

	test("encodes a small frame at full size", () => {
		const frame = capture(video(64, 48, 10));
		expect(frame?.picture).toBe(`data:image/jpeg;base64,${"A".repeat(3072)}`);
		expect(frame?.data).toBe("A".repeat(3072));
		expect([frame?.width, frame?.height]).toEqual([64, 48]);
	});

	test("scales a big frame down until it fits the vision limit, and keeps the frame size", () => {
		const frame = capture(video(3000, 2000, 10));
		expect([frame?.width, frame?.height]).toEqual([3000, 2000]);
		expect(((frame?.data.length ?? 0) * 3) / 4).toBeLessThanOrEqual(
			MAX_VISION_IMAGE_BYTES,
		);
	});
});

describe("bestDetection", () => {
	test("is null without detections", () => {
		expect(bestDetection([])).toBeNull();
	});

	test("is the most confident one, the first on a tie", () => {
		const a = detection(0.5);
		const b = detection(0.9);
		const c = detection(0.9);
		expect(bestDetection([a, b, c])).toBe(b);
	});
});

describe("usePictureCheck", () => {
	test("does nothing without a video frame", async () => {
		const calls = serve({});
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		await act(() => result.current.look(null));
		await act(() => result.current.look(video(0, 0)));
		expect(result.current.check).toBeNull();
		expect(calls).toEqual([]);
	});

	test.each<[ApiState<FamilyList>, CheckResult]>([
		[ready, { kind: "error", message: "No person is paired yet." }],
		[
			{ kind: "loading" },
			{ kind: "error", message: "Still loading. Try again." },
		],
		[
			{ kind: "forbidden", message: "Not a member." },
			{ kind: "forbidden", message: "Not a member." },
		],
	])(
		"without a family, shows the picture and why it was not sent (%o)",
		async (families, why) => {
			const calls = serve({});
			const { result } = renderHook(() => usePictureCheck(null, families));
			await act(() => result.current.look(video(64, 48, 10)));
			expect(result.current.check?.picture).toStartWith(
				"data:image/jpeg;base64,",
			);
			expect(result.current.check?.result).toEqual(why);
			expect(calls).toEqual([]);
		},
	);

	test("sends the full unrotated frame and marks only detections sure enough to show", async () => {
		const calls = serve({
			[detectionsPath]: detected([
				detection(0.9),
				detection(0.3),
				detection(0.4),
			]),
		});
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		let looked: Promise<void> = Promise.resolve();
		act(() => {
			looked = result.current.look(video(64, 48, 10));
		});
		expect(result.current.check?.result).toEqual({ kind: "looking" });
		await act(() => looked);
		const check = result.current.check;
		expect(check?.result).toEqual({
			kind: "done",
			detections: [detection(0.9), detection(0.4)],
		});
		expect(check?.frame).toEqual({ width: 64, height: 48 });
		expect(check?.capturedAt).toBe(NOW);
		expect(calls[0]?.body).toEqual({
			frame: {
				id: check?.id,
				capturedAt: "2026-10-04T12:00:00.000Z",
				width: 64,
				height: 48,
				crop: { x: 0, y: 0, width: 64, height: 48 },
				rotation: 0,
			},
			image: { type: "image/jpeg", data: "A".repeat(3072) },
		});
	});

	test("never shows a reply for another picture", async () => {
		serve({ [detectionsPath]: detected([detection(0.9)], "other") });
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		await act(() => result.current.look(video(64, 48, 10)));
		expect(result.current.check?.result).toEqual({
			kind: "error",
			message: "The reply was for another picture.",
		});
	});

	test("shows a failed check, never an empty one", async () => {
		serve({
			[detectionsPath]: {
				status: 503,
				body: { error: "unavailable", message: "No key." },
			},
		});
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		await act(() => result.current.look(video(64, 48, 10)));
		expect(result.current.check?.result).toEqual({
			kind: "unavailable",
			message: "No key.",
		});
	});

	test("stop drops the picture and its late reply", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		serve({ [detectionsPath]: () => reply.promise });
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		let looked: Promise<void> = Promise.resolve();
		act(() => {
			looked = result.current.look(video(64, 48, 10));
		});
		act(() => result.current.stop());
		expect(result.current.check).toBeNull();
		reply.resolve({ json: {} });
		await act(() => looked);
		expect(result.current.check).toBeNull();
	});

	test("a new look replaces a pending one, whose failure is dropped", async () => {
		const first = Promise.withResolvers<ServerReply>();
		const replies = [() => first.promise, detected([detection(0.9)])];
		const calls = serve({
			[detectionsPath]: (call) =>
				replies[calls.length - 1]?.(call) ?? { status: 500 },
		});
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		let looked: Promise<void> = Promise.resolve();
		act(() => {
			looked = result.current.look(video(64, 48, 10));
		});
		// The session token is read before the request goes: wait until the first one is pending.
		await waitFor(() => expect(calls.length).toBe(1));
		await act(() => result.current.look(video(32, 24, 10)));
		first.reject(new Error("aborted"));
		await act(() => looked);
		expect(calls.length).toBe(2);
		expect(result.current.check?.frame).toEqual({ width: 32, height: 24 });
		expect(result.current.check?.result.kind).toBe("done");
	});

	/** Shows a check of `camera` whose answer arrives once `answer` runs, then ticks motion checks. */
	const checkOf = async (camera: HTMLVideoElement) => {
		jest.useFakeTimers({ now: NOW });
		const reply = Promise.withResolvers<ServerReply>();
		const calls = serve({ [detectionsPath]: () => reply.promise });
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		let looked: Promise<void> = Promise.resolve();
		act(() => {
			looked = result.current.look(camera);
		});
		await waitFor(() => expect(calls.length).toBe(1));
		return {
			result,
			answer: async () => {
				reply.resolve(detected([detection(0.9)])(calls[0] as Call));
				await act(() => looked);
				expect(result.current.check?.result.kind).toBe("done");
			},
			/** Runs one motion check per half second. */
			checks: (n: number) => act(() => jest.advanceTimersByTime(n * 500)),
		};
	};

	test("keeps the markers while the camera holds still, and through one shaky check", async () => {
		const camera = video(64, 48, 10);
		document.body.append(camera);
		const { result, answer, checks } = await checkOf(camera);
		await answer();
		checks(4);
		expect(result.current.check?.result.kind).toBe("done");
		shade.set(camera, 200);
		checks(1);
		shade.set(camera, 10);
		checks(4);
		expect(result.current.check?.result.kind).toBe("done");
		camera.remove();
	});

	test("takes the markers away once the camera keeps moving", async () => {
		const camera = video(64, 48, 10);
		document.body.append(camera);
		const { result, answer, checks } = await checkOf(camera);
		await answer();
		shade.set(camera, 200);
		checks(1);
		expect(result.current.check?.result.kind).toBe("done");
		checks(1);
		expect(result.current.check?.result).toEqual({
			kind: "cleared",
			reason: "moved",
		});
		camera.remove();
	});

	test("motion while the answer is pending does not count", async () => {
		const camera = video(64, 48, 10);
		document.body.append(camera);
		const { result, answer, checks } = await checkOf(camera);
		// The wearer moves the phone while the model thinks; the answer compares from then on.
		shade.set(camera, 200);
		checks(10);
		await answer();
		checks(4);
		expect(result.current.check?.result.kind).toBe("done");
		camera.remove();
	});

	test("takes the markers away once the picture is over a minute old", async () => {
		serve({ [detectionsPath]: detected([detection(0.9)]) });
		const { result } = renderHook(() => usePictureCheck("f1", ready));
		await act(() => result.current.look(video(64, 48, 10)));
		expect(result.current.check?.result.kind).toBe("done");
		setSystemTime(NOW + 61_000);
		await waitFor(() =>
			expect(result.current.check?.result).toEqual({
				kind: "cleared",
				reason: "old",
			}),
		);
	});
});
