import { describe, expect, test } from "bun:test";
import type { AlertAcknowledgement, HealthSample } from "@health/contracts";
import type {
	AlertThreshold,
	FamilyAlert,
	ThresholdMonitoring,
} from "@health/contracts/alerts";

import { demoSampleSummary } from "@/lib/demo";

import {
	ago,
	clock,
	deliveryText,
	metricLabel,
	monitoringLevel,
	newestNoopSample,
	newestPerMetric,
	newestUnseen,
	seenText,
} from "./logic";

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
		expect(glance.map((g) => [g.sample?.id, g.stale])).toEqual([
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
	test("synthetic samples never count as a reading", () => {
		const samples = [
			{
				...sample("fake", "heart_rate", "2026-01-01T11:59:00Z"),
				synthetic: true,
			},
			sample("real", "heart_rate", "2026-01-01T11:58:00Z"),
			{ ...sample("hrv", "hrv", "2026-01-01T11:59:00Z"), synthetic: true },
		];
		expect(
			newestPerMetric(samples, [threshold], now).map((g) => [
				g.metric,
				g.sample?.id ?? null,
			]),
		).toEqual([
			["heart_rate", "real"],
			["hrv", null],
		]);
		expect(demoSampleSummary(samples)).toBe(
			"2 demo samples that are not real readings (heart_rate, hrv)",
		);
		expect(demoSampleSummary([sample("r", "hrv", now.toString())])).toBeNull();
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

describe("newestPerMetric without a threshold", () => {
	test("a reading is stale after a day", () => {
		const now = Date.parse("2026-01-02T12:00:00Z");
		const glance = newestPerMetric(
			[
				sample("old", "steps", "2026-01-01T11:00:00Z"),
				sample("day", "weight", "2026-01-01T13:00:00Z"),
			],
			[threshold],
			now,
		);
		expect(glance.map((g) => [g.metric, g.stale])).toEqual([
			["steps", true],
			["weight", false],
		]);
	});
});

test("a queued delivery with no try yet says only Queued", () => {
	expect(
		deliveryText({
			alertId: "1",
			status: "queued",
			attempts: 0,
			lastError: null,
			updatedAt: "",
		}),
	).toBe("Queued");
});

const ack = (member: string, acknowledgedAt: string): AlertAcknowledgement => ({
	id: member,
	alertId: "1",
	familyId: "1",
	member,
	acknowledgedAt,
});

const familyAlert = (
	id: string,
	acknowledgements: AlertAcknowledgement[] = [],
): FamilyAlert => ({
	alert: {
		id,
		familyId: "1",
		sampleId: null,
		summary: id,
		raisedBy: "a",
		createdAt: "2026-01-01T00:00:00Z",
	},
	sample: null,
	delivery: null,
	acknowledgements,
});

describe("newestUnseen", () => {
	test("the first alert with no acknowledgement, or null", () => {
		const seen = familyAlert("seen", [ack("m", "2026-01-01T00:00:00Z")]);
		expect(
			newestUnseen([seen, familyAlert("a"), familyAlert("b")])?.alert.id,
		).toBe("a");
		expect(newestUnseen([seen])).toBeNull();
		expect(newestUnseen([])).toBeNull();
	});
});

describe("newestNoopSample", () => {
	test("the newest NOOP sample of this family only", () => {
		const noop = (id: string, familyId: string, sourceTime: string) => ({
			...sample(id, "strain", sourceTime),
			familyId,
			source: "noop:whoop",
		});
		const samples = [
			noop("old", "1", "2026-01-01T10:00:00Z"),
			noop("new", "1", "2026-01-01T11:00:00Z"),
			noop("older", "1", "2026-01-01T09:00:00Z"),
			noop("other", "2", "2026-01-01T12:00:00Z"),
			sample("phone", "heart_rate", "2026-01-01T12:00:00Z"),
		];
		expect(newestNoopSample(samples, "1")?.id).toBe("new");
		expect(newestNoopSample(samples, "3")).toBeNull();
	});
});

describe("ago", () => {
	const now = Date.parse("2026-01-10T12:00:00Z");
	const before = (ms: number) => new Date(now - ms).toISOString();
	test("rounds to the largest useful unit", () => {
		expect(ago(before(20_000), now)).toBe("20 s ago");
		expect(ago(before(5 * 60_000), now)).toBe("5 min ago");
		expect(ago(before(59 * 60_000), now)).toBe("59 min ago");
		expect(ago(before(3 * 3_600_000), now)).toBe("3 h ago");
		expect(ago(before(47 * 3_600_000), now)).toBe("47 h ago");
		expect(ago(before(3 * 86_400_000), now)).toBe("3 days ago");
	});
	test("a time in the future is just now", () =>
		expect(ago(before(-60_000), now)).toBe("just now"));
});

test("clock shows the weekday and the time to the minute", () => {
	const iso = "2026-01-05T15:07:42Z";
	const text = clock(iso);
	const minutes = String(new Date(iso).getMinutes()).padStart(2, "0");
	expect(text).toContain(`:${minutes}`);
	expect(text).not.toContain(":42");
	expect(text).not.toContain("2026");
	expect(text).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
});

describe("seenText", () => {
	const me = "a".repeat(64);
	const other = `bcdef0${"1".repeat(58)}`;
	test("null when nobody saw the alert", () =>
		expect(seenText([], me)).toBeNull());
	test("names everyone who saw it, with the first time", () => {
		const first = "2026-01-05T15:07:00Z";
		expect(
			seenText([ack(me, first), ack(other, "2026-01-06T15:07:00Z")], me),
		).toBe(`You, Member bcdef0, ${clock(first)}`);
		expect(seenText([ack(me, first)], null)).toBe(
			`Member aaaaaa, ${clock(first)}`,
		);
	});
});

test("metricLabel turns a metric id into words", () => {
	expect(metricLabel("heart_rate")).toBe("Heart rate");
	expect(metricLabel("resting_heart_rate")).toBe("Resting heart rate");
	expect(metricLabel("")).toBe("");
});

test("a reading's age counts seconds under a minute", () => {
	const now = Date.parse("2026-01-01T12:00:00Z");
	const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
	expect(ago(at(2), now)).toBe("just now");
	expect(ago(at(12), now)).toBe("12 s ago");
	expect(ago(at(59), now)).toBe("59 s ago");
	expect(ago(at(90), now)).toBe("2 min ago");
	expect(ago(at(3 * 3600), now)).toBe("3 h ago");
});
