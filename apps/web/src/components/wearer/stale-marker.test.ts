import "../test/setup";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

import {
	clearedReason,
	difference,
	MARKER_TTL_MS,
	MOVED_ABOVE,
	MOVED_CHECKS,
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

/** A 256×192 RGBA frame of fine speckle (like label print) on large blocks, moved `dx` pixels. */
const speckle = (dx: number) => {
	const rgba = new Uint8ClampedArray(256 * 192 * 4);
	for (let i = 0; i < 256 * 192; i++) {
		const x = (i % 256) + dx;
		const y = Math.floor(i / 256);
		const block = ((Math.floor(x / 48) + Math.floor(y / 48)) % 2) * 120 + 60;
		const dot = (x * 7919 + y * 104729) % 10 < 3 ? -50 : 0;
		rgba.fill(block + dot, i * 4, i * 4 + 3);
		rgba[i * 4 + 3] = 255;
	}
	return rgba;
};

test("each cell averages its block, so a 1 px shake is not motion but a turned camera is", () => {
	const held = signature(speckle(0), 8);
	expect(difference(held, signature(speckle(1), 8))).toBeLessThan(
		MOVED_ABOVE / 2,
	);
	expect(difference(held, signature(speckle(48), 8))).toBeGreaterThan(
		MOVED_ABOVE,
	);
});

test("markers clear on sustained motion or age, and stay while the scene holds", () => {
	const at = 1_000_000;
	expect(clearedReason(at, at + 5_000, 0)).toBeNull();
	// One shaky check is jitter; motion must last MOVED_CHECKS checks in a row.
	expect(clearedReason(at, at + 5_000, MOVED_CHECKS - 1)).toBeNull();
	expect(clearedReason(at, at + 5_000, MOVED_CHECKS)).toBe("moved");
	expect(clearedReason(at, at + MARKER_TTL_MS, 0)).toBeNull();
	expect(clearedReason(at, at + MARKER_TTL_MS + 1, 0)).toBe("old");
});

describe("sample", () => {
	type Draw = { source: unknown; width: number; height: number };
	let draws: Draw[];
	/** What the stub 2D context reads back; `null` makes `getContext` fail like a browser can. */
	let pixels: Uint8ClampedArray | null;
	let original: PropertyDescriptor | undefined;
	beforeEach(() => {
		draws = [];
		pixels = speckle(0);
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

	const videoOf = (readyState: number, width = 640) => {
		const video = document.createElement("video");
		Object.defineProperty(video, "readyState", { value: readyState });
		Object.defineProperty(video, "videoWidth", { value: width });
		Object.defineProperty(video, "videoHeight", { value: 480 });
		document.body.append(video);
		return video;
	};

	test("a video frame is drawn once at 256×192 and averaged into 32×24 cells", () => {
		const video = videoOf(2);
		const signed = sample(video);
		expect(draws).toEqual([{ source: video, width: 256, height: 192 }]);
		expect(signed).toEqual(signature(speckle(0), 8));
	});

	test("no frame gives no signature", () => {
		expect(sample(null)).toBeNull();
		// A video that is not on the page, or has no current frame yet.
		const detached = document.createElement("video");
		expect(sample(detached)).toBeNull();
		expect(sample(videoOf(1))).toBeNull();
		// A video with no size yet.
		expect(sample(videoOf(2, 0))).toBeNull();
	});

	test("a transparent frame (not drawable yet) gives no signature", () => {
		pixels = new Uint8ClampedArray(256 * 192 * 4);
		expect(sample(videoOf(2))).toBeNull();
	});

	test("no 2D context gives no signature", () => {
		pixels = null;
		expect(sample(videoOf(2))).toBeNull();
	});
});
