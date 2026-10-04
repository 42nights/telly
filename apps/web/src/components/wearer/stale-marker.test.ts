import "../test/setup";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

import {
	clearedReason,
	difference,
	MARKER_TTL_MS,
	MOVED_ABOVE,
	sample,
	signature,
} from "./stale-marker";

installDom();

/** A 32×24 RGBA frame of 4-pixel vertical stripes shifted by `offset`, plus `light` on each channel. */
const stripes = (offset: number, light = 0) => {
	const rgba = new Uint8ClampedArray(32 * 24 * 4);
	for (let i = 0; i < 32 * 24; i++) {
		const v = (Math.floor(((i % 32) + offset) / 4) % 2) * 160 + 40 + light;
		rgba.fill(v, i * 4, i * 4 + 3);
		rgba[i * 4 + 3] = 255;
	}
	return rgba;
};

test("a brightness change is not motion, a moved scene is", () => {
	const checked = signature(stripes(0));
	expect(difference(checked, signature(stripes(0, 40)))).toBeLessThan(1);
	expect(difference(checked, signature(stripes(4)))).toBeGreaterThan(
		MOVED_ABOVE,
	);
});

test("markers clear on motion or age, and stay while the scene holds", () => {
	const at = 1_000_000;
	expect(clearedReason(at, at + 5_000, 2)).toBeNull();
	expect(clearedReason(at, at + 5_000, MOVED_ABOVE + 1)).toBe("moved");
	expect(clearedReason(at, at + MARKER_TTL_MS + 1, 2)).toBe("old");
	// No live video (camera off): only age clears the marker.
	expect(clearedReason(at, at + MARKER_TTL_MS, null)).toBeNull();
	expect(clearedReason(at, at + MARKER_TTL_MS + 1, null)).toBe("old");
});

describe("sample", () => {
	type Draw = { source: unknown; width: number; height: number };
	let draws: Draw[];
	/** What the stub 2D context reads back; `null` makes `getContext` fail like a browser can. */
	let pixels: Uint8ClampedArray | null;
	let original: PropertyDescriptor | undefined;
	beforeEach(() => {
		draws = [];
		pixels = stripes(0);
		original = Object.getOwnPropertyDescriptor(
			HTMLCanvasElement.prototype,
			"getContext",
		);
		Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
			configurable: true,
			value: () =>
				pixels === null
					? null
					: {
							drawImage: (
								source: unknown,
								_x: number,
								_y: number,
								width: number,
								height: number,
							) => draws.push({ source, width, height }),
							getImageData: () => ({ data: pixels }),
						},
		});
		Object.defineProperty(HTMLMediaElement, "HAVE_CURRENT_DATA", {
			configurable: true,
			value: 2,
		});
	});

	afterEach(() => {
		if (original)
			Object.defineProperty(
				HTMLCanvasElement.prototype,
				"getContext",
				original,
			);
		Reflect.deleteProperty(HTMLMediaElement, "HAVE_CURRENT_DATA");
	});

	const canvasOf = (width: number) => {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = 480;
		return canvas;
	};

	const videoOf = (readyState: number, width = 640) => {
		const video = document.createElement("video");
		Object.defineProperty(video, "readyState", { value: readyState });
		Object.defineProperty(video, "videoWidth", { value: width });
		Object.defineProperty(video, "videoHeight", { value: 480 });
		document.body.append(video);
		return video;
	};

	test("a checked frame is shrunk to 32×24 and compared without its brightness", () => {
		const canvas = canvasOf(640);
		const signed = sample(canvas);
		expect(draws).toEqual([{ source: canvas, width: 32, height: 24 }]);
		expect(signed).toEqual(signature(stripes(0)));
	});

	test("a video frame is drawn full size first, then shrunk", () => {
		const video = videoOf(2);
		const signed = sample(video);
		expect(draws.map(({ width, height }) => [width, height])).toEqual([
			[640, 480],
			[32, 24],
		]);
		expect(draws[0]?.source).toBe(video);
		expect(draws[1]?.source).toBeInstanceOf(HTMLCanvasElement);
		expect(signed).toEqual(signature(stripes(0)));
	});

	test("no frame gives no signature", () => {
		expect(sample(null)).toBeNull();
		// A video that is not on the page, or has no current frame yet.
		const detached = document.createElement("video");
		expect(sample(detached)).toBeNull();
		expect(sample(videoOf(1))).toBeNull();
		// A video with no size yet, and an empty canvas.
		expect(sample(videoOf(2, 0))).toBeNull();
		expect(sample(canvasOf(0))).toBeNull();
	});

	test("a transparent frame (not drawable yet) gives no signature", () => {
		pixels = new Uint8ClampedArray(32 * 24 * 4);
		expect(sample(canvasOf(640))).toBeNull();
	});

	test("no 2D context gives no signature", () => {
		pixels = null;
		expect(sample(canvasOf(640))).toBeNull();
		expect(sample(videoOf(2))).toBeNull();
	});
});
