import { describe, expect, test } from "bun:test";

import {
	boxOf,
	follow,
	type Gray,
	LOST_AFTER,
	lockOn,
	RECHECK_EVERY_MS,
	RECHECK_FOR_MS,
	recheckDue,
	type Track,
} from "./tracker";

const W = 160;
const H = 120;
const SIDE = 24;

/** Seeded noise, so every run sees the same pictures. */
const noise = (seed: number) => {
	let s = seed;
	return () => {
		s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
		return (s / 2_147_483_648) * 255;
	};
};

// Smooth blobs: real objects and rooms change slowly from pixel to pixel.
const texture = (seed: number, width: number, height: number) => {
	const next = noise(seed);
	const coarse = Array.from({ length: 64 }, next);
	return Float32Array.from({ length: width * height }, (_, i) => {
		const x = (i % width) / 4;
		const y = Math.floor(i / width) / 4;
		return coarse[(Math.floor(x) * 7 + Math.floor(y) * 13) % 64] ?? 0;
	});
};

const ROOM = texture(1, W, H);
const OBJECT = texture(2, SIDE, SIDE);

/** The room with the object at (x, y), or without it. */
const frame = (at: { x: number; y: number } | null): Gray => {
	const data = Float32Array.from(ROOM);
	if (at !== null)
		for (let y = 0; y < SIDE; y++)
			for (let x = 0; x < SIDE; x++)
				data[(at.y + y) * W + at.x + x] = OBJECT[y * SIDE + x] ?? 0;
	return { width: W, height: H, data };
};

/** The tracked box is within 2 px of the object's corner. */
const near = (t: Track, x: number, y: number) => {
	const b = boxOf(t);
	return Math.abs(b.x - x) <= 2 && Math.abs(b.y - y) <= 2;
};

describe("tracker", () => {
	test("follows the object, loses it when it goes, and locks on again where it comes back", () => {
		let track = lockOn(frame({ x: 30, y: 40 }), {
			x: 30,
			y: 40,
			width: SIDE,
			height: SIDE,
		});
		// The camera moves: the object slides across the frame a few pixels a frame.
		for (let x = 34; x <= 70; x += 4) {
			track = follow(track, frame({ x, y: 44 }));
			expect(track.locked).toBe(true);
			expect(near(track, x, 44)).toBe(true);
		}

		// It leaves the frame: still locked for a few frames, then lost at the last place.
		for (let i = 1; i < LOST_AFTER; i++) {
			track = follow(track, frame(null));
			expect(track.locked).toBe(true);
		}
		track = follow(track, frame(null));
		expect(track.locked).toBe(false);
		expect(near(track, 70, 44)).toBe(true);
		// Nothing like it in the room: it stays lost.
		track = follow(track, frame(null));
		expect(track.locked).toBe(false);

		// It comes back on the other side of the frame, without a new photo.
		track = follow(track, frame({ x: 120, y: 80 }));
		expect(track.locked).toBe(true);
		expect(near(track, 120, 80)).toBe(true);
	});
});

describe("recheckDue", () => {
	const lost = { lostAt: 0, inView: true, lastAt: null };

	test("asks Gemini at most once per RECHECK_EVERY_MS while lost", () => {
		expect(recheckDue({ ...lost, now: 100 })).toBe(true);
		expect(
			recheckDue({ ...lost, lastAt: 100, now: 100 + RECHECK_EVERY_MS - 1 }),
		).toBe(false);
		expect(
			recheckDue({ ...lost, lastAt: 100, now: 100 + RECHECK_EVERY_MS }),
		).toBe(true);
	});

	test("never while locked, off view, or long lost", () => {
		expect(recheckDue({ ...lost, lostAt: null, now: 100 })).toBe(false);
		expect(recheckDue({ ...lost, inView: false, now: 100 })).toBe(false);
		expect(recheckDue({ ...lost, now: RECHECK_FOR_MS })).toBe(false);
	});
});
