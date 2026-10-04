import { expect, test } from "bun:test";

import {
	clearedReason,
	difference,
	MARKER_TTL_MS,
	MOVED_ABOVE,
	signature,
} from "./stale-marker";

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
