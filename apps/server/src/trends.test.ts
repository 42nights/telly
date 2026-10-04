// All records are synthetic.
import { describe, expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";
import type { FinchnodeSubjectLabs } from "@health/contracts/reports";
import { explainTrend } from "./trends";

const now = new Date("2026-10-04T12:00:00Z");
let nextId = 0;
const sample = (
	metric: string,
	value: number,
	sourceTime: string,
	extra: Partial<HealthSample> = {},
): HealthSample => ({
	id: String(nextId++),
	familyId: "1",
	metric,
	value,
	unit: "ms",
	sourceTime,
	receivedAt: sourceTime,
	source: "strap-a",
	synthetic: false,
	quality: "validated",
	...extra,
});

const subject = (
	labs: FinchnodeSubjectLabs["labs"],
	extra: Partial<FinchnodeSubjectLabs> = {},
): FinchnodeSubjectLabs => ({
	subject: "s1",
	synthetic: true,
	access: "granted",
	syncStatus: "complete",
	dataAsOf: "2026-10-03T00:00:00Z",
	warnings: [],
	sources: [],
	labs,
	...extra,
});

const lab = (
	name: string,
	value: string | number | null,
	date: string | null,
) => ({
	id: `${name}-${date}`,
	name,
	value,
	unit: "%",
	status: "final",
	date,
	referenceRange: null,
	interpretation: null,
	source: "ehr",
	sourceName: "Synthetic Clinic",
	sourceRecordId: null,
	codes: [],
	sourceUpdatedAt: null,
	syncedAt: null,
});

const explain = (extra: Partial<Parameters<typeof explainTrend>[0]> = {}) =>
	explainTrend({
		question: "Is her HRV getting better?",
		days: 7,
		now,
		samples: [],
		labs: [],
		asker: "abc",
		...extra,
	});

describe("explainTrend", () => {
	test("each observation keeps its kind, source, period, unit, quality, and sync age", () => {
		const reply = explain({
			samples: [
				sample("hrv", 44, "2026-10-04T08:00:00Z", {
					receivedAt: "2026-10-04T11:00:00Z",
				}),
				sample("hrv", 40, "2026-09-30T08:00:00Z"),
				sample("recovery", 60, "2026-10-04T07:00:00Z", {
					unit: "%",
					synthetic: true,
					quality: "unvalidated",
				}),
				sample("nutrition_kcal", 1800, "2026-10-03T20:00:00Z", {
					unit: "kcal",
				}),
			],
			labs: [
				subject([
					lab("HbA1c", 6.5, "2025-03-01"),
					lab("HbA1c", 5.8, "2025-09-01"),
					lab("LDL", 3, null),
				]),
			],
		});
		const by = (label: string) =>
			reply.observations.filter((o) => o.label === label);

		expect(by("question")).toMatchObject([
			{ kind: "reported", quality: "self_reported", source: "abc" },
		]);
		expect(by("hrv")).toEqual([
			{
				kind: "measured",
				label: "hrv",
				source: "strap-a",
				synthetic: false,
				quality: "validated",
				unit: "ms",
				from: "2026-09-30T08:00:00Z",
				to: "2026-10-04T08:00:00Z",
				first: 40,
				last: 44,
				count: 2,
				direction: "up",
				lastSyncAt: "2026-10-04T11:00:00Z",
				lastSyncMinutes: 60,
				stale: false,
			},
		]);
		expect(by("recovery")).toMatchObject([
			{ kind: "derived", synthetic: true, quality: "unvalidated" },
		]);
		expect(by("nutrition_kcal")).toMatchObject([
			{ kind: "nutrition_estimate" },
		]);
		// Old labs keep their own dates and show as older than the period.
		expect(by("HbA1c")).toMatchObject([
			{
				kind: "measured",
				source: "FinchNode · Synthetic Clinic",
				quality: "source_reported",
				from: "2025-03-01",
				to: "2025-09-01",
				direction: "down",
				lastSyncAt: "2026-10-03T00:00:00Z",
				stale: true,
			},
		]);
		expect(reply.unknown).toContain("LDL: the source gave no date.");
		expect(reply.unknown).not.toContain(
			"Nutrition estimates: none are recorded.",
		);
		expect(reply.cautions).toContain(
			"Records marked synthetic are demo data, not real measurements. They start no alert or nudge.",
		);
	});

	test("missing and conflicting data are named, never read as normal", () => {
		const reply = explain({
			samples: [
				sample("hrv", 50, "2026-10-01T08:00:00Z"),
				sample("hrv", 40, "2026-10-04T08:00:00Z"),
				sample("hrv", 40, "2026-10-01T08:00:00Z", { source: "strap-b" }),
				sample("hrv", 50, "2026-10-02T08:00:00Z", { source: "strap-b" }),
				sample("spo2", 97, "2026-09-01T08:00:00Z", { unit: "%" }),
			],
			labs: "FinchNode is not set up on this server.",
		});
		expect(reply.conflicts).toEqual([
			"hrv: strap-b went up while strap-a went down.",
		]);
		expect(reply.unknown).toEqual([
			"WHOOP data through NOOP: not connected.",
			"spo2: no samples in this period. The last one is from 2026-09-01T08:00:00Z.",
			"Lab results: FinchNode is not set up on this server.",
			"Nutrition estimates: none are recorded.",
		]);
		// The strap-b series ended over a day ago.
		expect(reply.observations.find((o) => o.source === "strap-b")?.stale).toBe(
			true,
		);
		expect(
			explain({ labs: [subject([], { access: "inactive" })] }).unknown,
		).toEqual([
			"WHOOP data through NOOP: not connected.",
			"No wearable or device samples in the last 7 days.",
			"Lab results: the patient stopped sharing them.",
			"Nutrition estimates: none are recorded.",
		]);
	});

	test("small changes are flat; numeric text has a direction; other text has none", () => {
		const reply = explain({
			samples: [
				sample("rhr", 60, "2026-10-01T08:00:00Z"),
				sample("rhr", 62, "2026-10-04T08:00:00Z"),
				sample("hr", 70, "2026-10-04T08:00:00Z"),
			],
			labs: [
				subject([
					lab("Culture", "negative", "2026-10-01"),
					lab("Culture", "positive", "2026-10-02"),
					lab("Glucose", "112", "2026-01-18"),
					lab("Glucose", "98", "2026-07-18"),
				]),
			],
		});
		const direction = (label: string) =>
			reply.observations.find((o) => o.label === label)?.direction;
		expect(direction("rhr")).toBe("flat");
		expect(direction("hr")).toBe("single");
		expect(direction("Culture")).toBe("text");
		expect(direction("Glucose")).toBe("down");
	});

	test("offers only a check-in or a review, and never heart-attack detection", () => {
		const reply = explain({ question: "Could this be a heart attack?" });
		expect(reply.nextSteps.map((step) => step.kind)).toEqual([
			"check_in",
			"review",
		]);
		expect(reply.carePlan.status).toBe("unavailable");
		expect(reply.cautions[0]).toStartWith(
			"Telly cannot detect or predict a heart attack.",
		);
		expect(explain().cautions).not.toContainEqual(
			expect.stringContaining("heart attack"),
		);
	});
});
