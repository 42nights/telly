import { describe, expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";
import type {
	AlertThreshold,
	ThresholdMonitoring,
} from "@health/contracts/alerts";

import { deliveryText, monitoringLevel, newestPerMetric } from "./logic";

const threshold: AlertThreshold = {
	id: "1",
	familyId: "1",
	metric: "heart_rate",
	direction: "above",
	limit: 110,
	unit: "bpm",
	maxAgeSeconds: 600,
	updatedBy: "a",
	updatedAt: "2026-01-01T00:00:00Z",
};

const row = (state: ThresholdMonitoring["state"]): ThresholdMonitoring => ({
	threshold,
	state,
	reason: state === "unavailable" ? "stale" : null,
	sample: null,
});

const sample = (
	id: string,
	metric: string,
	sourceTime: string,
): HealthSample => ({
	id,
	familyId: "1",
	metric,
	value: 1,
	unit: "u",
	sourceTime,
	receivedAt: sourceTime,
	source: "phone",
	synthetic: false,
	quality: "validated",
});

describe("monitoringLevel", () => {
	const level = (states: ThresholdMonitoring["state"][]) =>
		monitoringLevel({ checkedAt: "", thresholds: states.map(row) });
	test("no thresholds is stopped", () => expect(level([])).toBe("stopped"));
	test("all unavailable is stopped", () =>
		expect(level(["unavailable"])).toBe("stopped"));
	test("mixed is partial", () =>
		expect(level(["in_range", "unavailable"])).toBe("partial"));
	test("every threshold live is on", () =>
		expect(level(["in_range", "out_of_range"])).toBe("on"));
});

describe("newestPerMetric", () => {
	const now = Date.parse("2026-01-01T12:00:00Z");
	test("keeps the newest by source time, per metric", () => {
		const glance = newestPerMetric(
			[
				sample("old", "heart_rate", "2026-01-01T11:00:00Z"),
				sample("new", "heart_rate", "2026-01-01T11:58:00Z"),
				sample("steps", "steps", "2026-01-01T10:00:00Z"),
			],
			[threshold],
			now,
		);
		expect(glance.map((g) => [g.sample.id, g.stale])).toEqual([
			["new", false],
			["steps", false],
		]);
	});
	test("threshold max age marks stale", () => {
		const [hr] = newestPerMetric(
			[sample("hr", "heart_rate", "2026-01-01T11:00:00Z")],
			[threshold],
			now,
		);
		expect(hr?.stale).toBe(true);
	});
});

describe("deliveryText", () => {
	const delivery = (
		status: "queued" | "sent" | "failed" | "unavailable",
		attempts: number,
	) =>
		deliveryText({
			alertId: "1",
			status,
			attempts,
			lastError: null,
			updatedAt: "",
		});
	test("one status per alert", () => {
		expect(delivery("sent", 1)).toBe("Sent");
		expect(delivery("failed", 3)).toBe("Failed after 3 tries");
		expect(delivery("unavailable", 0)).toBe("Not sent: no delivery transport");
		expect(delivery("queued", 1)).toBe("Queued, 1 try so far");
		expect(deliveryText(null)).toBe("No delivery record");
	});
});
