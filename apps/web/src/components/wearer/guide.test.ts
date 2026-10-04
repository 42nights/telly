import { describe, expect, test } from "bun:test";

import { edgeHint, guideWords, roomDirection, seenAt } from "./guide";

const FRAME = { width: 480, height: 640 };
const center = { x: 240, y: 320 };
// Held upright in front of you, screen toward you.
const upright = { alpha: 0, beta: 90, gamma: 0 };

describe("the guide arrow", () => {
	const ahead = roomDirection(upright, center, FRAME, 0);

	test("shows a locked object on screen while the phone still points at it", () => {
		const seen = seenAt(ahead, upright, FRAME, 0);
		expect(seen.kind).toBe("in");
		if (seen.kind === "in") {
			expect(seen.x).toBeCloseTo(center.x);
			expect(seen.y).toBeCloseTo(center.y);
		}
	});

	test("points right when you turn left, and behind you when you turn around", () => {
		const left = seenAt(ahead, { ...upright, alpha: 60 }, FRAME, 0);
		expect(left).toMatchObject({ kind: "off", behind: false });
		if (left.kind === "off")
			expect(guideWords(left.angle, left.behind)).toBe("Turn right");

		const right = seenAt(ahead, { ...upright, alpha: -60 }, FRAME, 0);
		if (right.kind === "off")
			expect(guideWords(right.angle, right.behind)).toBe("Turn left");

		const around = seenAt(ahead, { ...upright, alpha: 150 }, FRAME, 0);
		expect(around).toMatchObject({ kind: "off", behind: true });
		if (around.kind === "off")
			expect(guideWords(around.angle, around.behind)).toBe(
				"It is behind you. Turn right",
			);
	});

	test("points down when you tilt the phone up", () => {
		const seen = seenAt(ahead, { ...upright, beta: 140 }, FRAME, 0);
		if (seen.kind !== "off") throw new Error("expected off screen");
		expect(guideWords(seen.angle, seen.behind)).toBe("Tilt down");
	});

	test("a box near the side of the frame moves on screen as the phone turns that way", () => {
		const nearRight = roomDirection(upright, { x: 400, y: 320 }, FRAME, 0);
		const turned = seenAt(nearRight, { ...upright, alpha: -10 }, FRAME, 0);
		expect(turned.kind).toBe("in");
		if (turned.kind === "in") expect(turned.x).toBeLessThan(400);
	});
});

describe("edgeHint", () => {
	const words = (x: number, y: number) => {
		const angle = edgeHint({ x, y }, FRAME);
		return angle === null ? null : guideWords(angle, false);
	};

	test("points to the edge where the object left the frame", () => {
		expect(words(20, 320)).toBe("Turn left");
		expect(words(470, 300)).toBe("Turn right");
		expect(words(240, 10)).toBe("Tilt up");
		expect(words(250, 630)).toBe("Tilt down");
	});

	test("has no direction for an object lost in the middle of the frame", () => {
		expect(words(240, 320)).toBeNull();
	});
});
