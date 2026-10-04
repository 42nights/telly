import { describe, expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";
import type { AlertThreshold } from "@health/contracts/alerts";
import { monitor } from "./records";

const now = new Date("2026-01-01T12:00:00.000Z");
const threshold: AlertThreshold = {
	id: "1",
	familyId: "7",
	metric: "heart_rate",
	direction: "above",
	limit: 110,
	unit: "bpm",
	maxAgeSeconds: 300,
	updatedBy: "aa",
	updatedAt: "2026-01-01T00:00:00.000000Z",
};
const sample = (
	secondsAgo: number,
	value: number,
	change: Partial<HealthSample> = {},
): HealthSample => ({
	id: String(secondsAgo),
	familyId: "7",
	metric: "heart_rate",
	value,
	unit: "bpm",
	sourceTime: new Date(now.getTime() - secondsAgo * 1000).toISOString(),
	receivedAt: now.toISOString(),
	source: "synthetic-demo",
	synthetic: true,
	quality: "validated",
	...change,
});
const stateOf = (samples: HealthSample[], rule = threshold) => {
	const [result] = monitor([rule], samples, now).thresholds;
	if (result === undefined) throw new Error("no monitoring result");
	return { state: result.state, reason: result.reason };
};

describe("monitoring never reports in range without fresh validated data", () => {
	test("no sample, or none usable, is missing", () => {
		const unusable = [
			sample(10, 90, { quality: "unvalidated" }),
			sample(10, 90, { unit: "beats/min" }),
			sample(10, 90, { familyId: "8" }),
		];
		for (const samples of [[], unusable])
			expect(stateOf(samples)).toEqual({
				state: "unavailable",
				reason: "missing",
			});
	});

	test("freshness ends exactly at maxAgeSeconds, and a far-future source time is stale", () => {
		expect(stateOf([sample(300, 90)]).state).toBe("in_range");
		expect(stateOf([sample(301, 90)])).toEqual({
			state: "unavailable",
			reason: "stale",
		});
		expect(stateOf([sample(-61, 90)]).reason).toBe("stale");
	});

	test("the limit itself is in range; only strictly beyond it is out of range", () => {
		expect(stateOf([sample(10, 110)]).state).toBe("in_range");
		expect(stateOf([sample(10, 110.1)]).state).toBe("out_of_range");
		const below = { ...threshold, direction: "below" as const, limit: 92 };
		expect(stateOf([sample(10, 92)], below).state).toBe("in_range");
		expect(stateOf([sample(10, 91.9)], below).state).toBe("out_of_range");
	});

	test("the newest sample by source time decides, whatever the arrival order", () => {
		expect(stateOf([sample(5, 90), sample(60, 150)]).state).toBe("in_range");
		expect(stateOf([sample(60, 90), sample(5, 150)]).state).toBe(
			"out_of_range",
		);
	});
});
