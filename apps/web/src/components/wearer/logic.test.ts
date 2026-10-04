import { describe, expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";

import {
	ago,
	direction,
	emergencyIntent,
	evidenceLine,
	isMedicineRequest,
	itemFromRequest,
	marker,
	SIGHTING_OLD_MS,
	sightingState,
} from "./logic";

const now = Date.parse("2026-10-04T12:00:00Z");
const sample = (
	id: string,
	minutesAgo: number,
	extra: Partial<HealthSample> = {},
): HealthSample => ({
	id,
	familyId: "1",
	metric: "heart_rate",
	value: 72,
	unit: "bpm",
	sourceTime: new Date(now - minutesAgo * 60_000).toISOString(),
	receivedAt: new Date(now).toISOString(),
	source: "phone",
	synthetic: false,
	quality: "validated",
	...extra,
});

describe("medicine requests", () => {
	test("medicine words open the finder; other questions do not", () => {
		expect(isMedicineRequest("Where are my meds?")).toBe(true);
		expect(isMedicineRequest("did I take my PILLS")).toBe(true);
		expect(isMedicineRequest("When is Priya calling?")).toBe(false);
		expect(isMedicineRequest("Remind me about the medal")).toBe(false);
	});

	test("the item name comes from the request words", () => {
		expect(itemFromRequest("Where are my meds?")).toBe("your medicine");
		expect(itemFromRequest("find my blood pressure pills")).toBe(
			"your blood pressure pills",
		);
		expect(itemFromRequest("I need my pills now")).toBe("your pills");
		expect(itemFromRequest("where are the vitamins")).toBe("your vitamins");
		expect(itemFromRequest("")).toBe("your medicine");
	});
});

test("evidence reads as a short line with source and age, and marks old samples", () => {
	expect(evidenceLine({ ...sample("e", 3), stale: false }, now)).toBe(
		"Heart rate 72 bpm · from phone · 3 min ago",
	);
	expect(evidenceLine({ ...sample("e", 30 * 60), stale: true }, now)).toBe(
		"Heart rate 72 bpm · from phone · 30 h ago (old)",
	);
	expect(
		evidenceLine({ ...sample("e", 3), stale: true, synthetic: true }, now),
	).toBe("Heart rate 72 bpm · from phone · 3 min ago (demo, not real)");
});

test("an urgent request dispatches; an ouch alone gets a check-in", () => {
	expect(emergencyIntent("Ouch, I fell and can't get up")).toBe("help");
	expect(emergencyIntent("Help!")).toBe("help");
	expect(emergencyIntent("ouch")).toBe("ouch");
	expect(emergencyIntent("I need help finding my pills")).toBeNull();
	expect(emergencyIntent("How is my heart rate?")).toBeNull();
});

describe("marker", () => {
	const frame = { width: 1000, height: 500 };

	test("clamps a box that runs off the frame", () => {
		expect(
			marker({ x: -10, y: 400, width: 100, height: 200 }, frame).rect,
		).toEqual({ x: 0, y: 400, width: 90, height: 100 });
	});

	test("the arrow comes from below for a high box and from above for a low box", () => {
		const high = marker({ x: 400, y: 50, width: 200, height: 100 }, frame);
		expect(high.arrow.startsWith("M500 500")).toBe(true);
		const low = marker({ x: 400, y: 380, width: 200, height: 100 }, frame);
		expect(low.arrow.startsWith("M500 0")).toBe(true);
	});
});

test("a remembered sighting is marked old, outdated, or unsure, never current", () => {
	const seen = {
		seenAt: new Date(now - 60_000).toISOString(),
		notFoundAt: null,
		confidence: 0.9,
		labelRead: true,
	};
	expect(sightingState(seen, now)).toEqual({
		outdated: false,
		old: false,
		unsure: false,
	});
	const stale = {
		...seen,
		seenAt: new Date(now - SIGHTING_OLD_MS - 1).toISOString(),
	};
	expect(sightingState(stale, now).old).toBe(true);
	const moved = { ...seen, notFoundAt: new Date(now).toISOString() };
	expect(sightingState(moved, now).outdated).toBe(true);
	expect(sightingState({ ...seen, confidence: 0.5 }, now).unsure).toBe(true);
	expect(sightingState({ ...seen, labelRead: false }, now).unsure).toBe(true);
});

test("an age reads in the largest whole unit", () => {
	expect(ago(4_000)).toBe("just now");
	expect(ago(42_000)).toBe("42 s ago");
	expect(ago(3 * 60_000)).toBe("3 min ago");
	expect(ago(2 * 3600_000)).toBe("2 h ago");
});

test("a direction names the side and the height of the box centre", () => {
	const frame = { width: 900, height: 900 };
	expect(direction({ x: 0, y: 0, width: 100, height: 100 }, frame)).toBe(
		"Look to the left, high up.",
	);
	expect(direction({ x: 800, y: 800, width: 100, height: 100 }, frame)).toBe(
		"Look to the right, low down.",
	);
	expect(direction({ x: 400, y: 400, width: 100, height: 100 }, frame)).toBe(
		"Look straight ahead.",
	);
});
