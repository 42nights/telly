import { describe, expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";

import {
	ago,
	barPercent,
	categoryOfRequest,
	currentHeartRate,
	direction,
	emergencyIntent,
	evidenceLine,
	HEART_RATE_FRESH_MS,
	isFindRequest,
	itemFromRequest,
	marker,
	SIGHTING_OLD_MS,
	sightingState,
	USUAL_BPM,
	whenSeen,
	whoopHeartRate,
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

describe("currentHeartRate", () => {
	test("picks the newest validated sample, not the newest sample", () => {
		const samples = [
			sample("old", 5),
			sample("new", 3),
			sample("unvalidated", 1, { quality: "unvalidated" }),
			sample("synthetic", 1, { synthetic: true }),
			sample("other family", 1, { familyId: "2" }),
			sample("other metric", 1, { metric: "spo2" }),
		];
		expect(currentHeartRate(samples, "1", now)?.id).toBe("new");
	});

	test("a stale newest sample is no reading, even when it is validated", () => {
		const minutes = HEART_RATE_FRESH_MS / 60_000 + 1;
		expect(currentHeartRate([sample("stale", minutes)], "1", now)).toBeNull();
	});

	test("a sample from far in the future is not fresh", () => {
		expect(currentHeartRate([sample("ahead", -5)], "1", now)).toBeNull();
	});
});

describe("find requests", () => {
	test("medicine words, and finding a known object, open the finder; other questions do not", () => {
		expect(isFindRequest("Where are my meds?")).toBe(true);
		expect(isFindRequest("did I take my PILLS")).toBe(true);
		expect(isFindRequest("where are my keys?")).toBe(true);
		expect(isFindRequest("I lost my reading glasses")).toBe(true);
		expect(isFindRequest("Call my phone")).toBe(false);
		expect(isFindRequest("Where is my daughter?")).toBe(false);
		expect(isFindRequest("When is Priya calling?")).toBe(false);
		expect(isFindRequest("Remind me about the medal")).toBe(false);
	});

	test("the request names the category the arrow prefers", () => {
		expect(categoryOfRequest("where are my pills")).toBe("medicine");
		expect(categoryOfRequest("find my hearing aid")).toBe("hearing aid");
		expect(categoryOfRequest("where did I leave my purse")).toBe("wallet");
		expect(categoryOfRequest("")).toBeNull();
	});

	test("the item name comes from the request words", () => {
		expect(itemFromRequest("Where are my meds?")).toBe("your medicine");
		expect(itemFromRequest("find my blood pressure pills")).toBe(
			"your blood pressure pills",
		);
		expect(itemFromRequest("I need my pills now")).toBe("your pills");
		expect(itemFromRequest("where are the vitamins")).toBe("your vitamins");
		expect(itemFromRequest("where are my car keys?")).toBe("your car keys");
		expect(itemFromRequest("")).toBe("your things");
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

test("the WHOOP reading counts only the WHOOP source, validated or not", () => {
	const samples = [
		sample("phone", 1),
		sample("whoop", 2, { source: "noop:whoop", quality: "unvalidated" }),
		sample("whoop demo", 1, { source: "noop:whoop", synthetic: true }),
	];
	expect(whoopHeartRate(samples, "1", now)?.id).toBe("whoop");
	expect(whoopHeartRate([sample("phone", 1)], "1", now)).toBeNull();
	expect(currentHeartRate(samples, "1", now)?.id).toBe("phone");
});

test("an age reads in the largest whole unit", () => {
	expect(ago(4_000)).toBe("just now");
	expect(ago(42_000)).toBe("42 s ago");
	expect(ago(3 * 60_000)).toBe("3 min ago");
	expect(ago(2 * 3600_000)).toBe("2 h ago");
});

test("the range bar places a reading and clamps it to the bar ends", () => {
	expect(barPercent(105)).toBe(50);
	expect(barPercent(USUAL_BPM.low)).toBe(20);
	expect(barPercent(10)).toBe(0);
	expect(barPercent(250)).toBe(100);
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

test("a last-seen time reads in the words of the person's own day", () => {
	const now = Date.parse("2026-10-04T18:00:00");
	expect(whenSeen("2026-10-04T18:01:00", now)).toBe("just now");
	expect(whenSeen("2026-10-04T17:48:00", now)).toBe("12 minutes ago");
	expect(whenSeen("2026-10-04T09:00:00", now)).toBe("this morning");
	expect(whenSeen("2026-10-04T15:00:00", now)).toBe("this afternoon");
	expect(whenSeen("2026-10-04T17:00:00", now)).toBe("this evening");
	expect(whenSeen("2026-10-03T19:00:00", now)).toBe("yesterday evening");
	const weekday = "2026-10-01T10:00:00";
	expect(whenSeen(weekday, now)).toBe(
		`${new Date(weekday).toLocaleDateString([], { weekday: "long" })} morning`,
	);
	const older = "2026-09-14T10:00:00";
	expect(whenSeen(older, now)).toBe(
		new Date(older).toLocaleDateString([], { month: "long", day: "numeric" }),
	);
});
