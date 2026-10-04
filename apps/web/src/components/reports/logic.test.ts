import { describe, expect, test } from "bun:test";
import { type FinchnodeLab, ReportFields } from "@health/contracts/reports";
import { Schema } from "effect";

import {
	demoText,
	draftChanged,
	draftOf,
	FIELD_LIMITS,
	type FieldName,
	fieldErrors,
	fieldsOf,
	formatTime,
	labRange,
	labValue,
	markerValue,
	metricLabel,
} from "./logic";

const empty = draftOf(
	Schema.decodeUnknownSync(ReportFields)({
		patientName: null,
		dateOfBirth: null,
		patientId: null,
		physician: null,
		hospital: null,
		notes: null,
	}),
);

describe("report fields", () => {
	test("the form's limits are the shared schema's limits", () => {
		for (const name of Object.keys(FIELD_LIMITS) as FieldName[])
			for (const length of [FIELD_LIMITS[name], FIELD_LIMITS[name] + 1]) {
				const draft = { ...empty, [name]: "x".repeat(length) };
				const accepted = Schema.is(ReportFields)(fieldsOf(draft));
				expect([name, accepted]).toEqual([
					name,
					fieldErrors(draft)[name] === undefined,
				]);
			}
	});

	test("an empty box is sent as null", () => {
		expect(fieldsOf({ ...empty, physician: "  Dr. Lee " }).physician).toBe(
			"Dr. Lee",
		);
		expect(fieldsOf({ ...empty, physician: "   " }).physician).toBeNull();
	});

	test("a correction is a change; surrounding spaces are not", () => {
		expect(draftChanged({ ...empty, notes: "  " }, empty)).toBe(false);
		const correction = { metric: "hrv", value: 45, reason: "Typo" };
		const corrected = { ...empty, corrections: [correction] };
		expect(draftChanged(corrected, empty)).toBe(true);
		expect(draftChanged(corrected, draftOf(fieldsOf(corrected)))).toBe(false);
	});
});

test("a marker without a sample is unavailable", () => {
	expect(markerValue({ metric: "heart_rate", sample: null })).toBe(
		"Unavailable",
	);
});

const lab: FinchnodeLab = {
	id: "1",
	name: "Hemoglobin",
	value: 13.2,
	unit: "g/dL",
	status: "final",
	date: null,
	referenceRange: "12.0-15.5",
	interpretation: null,
	source: null,
	sourceName: null,
	sourceRecordId: null,
	codes: [],
	sourceUpdatedAt: null,
	syncedAt: null,
};

describe("lab display", () => {
	test("value keeps the source's unit, or says none was reported", () => {
		expect(labValue(lab)).toBe("13.2 g/dL");
		expect(labValue({ ...lab, value: "positive", unit: null })).toBe(
			"positive",
		);
		expect(labValue({ ...lab, value: null })).toBe("No value reported");
	});

	test("a range shows only with its source", () => {
		expect(labRange(lab)).toBeNull();
		expect(labRange({ ...lab, source: "epic" })).toBe(
			"12.0-15.5 (range from epic)",
		);
	});
});

test("demoText says demo for synthetic, in the same case", () => {
	expect(demoText("Northstar Health System (Synthetic)")).toBe(
		"Northstar Health System (Demo)",
	);
	expect(demoText("synthetic reference: SYNTHETIC")).toBe(
		"demo reference: DEMO",
	);
	expect(demoText("synthetic_data")).toBe(
		"Demo records, not real patient data",
	);
	expect(demoText("4.5 mmol/L")).toBe("4.5 mmol/L");
});

test("metricLabel turns a metric key into a sentence-case label", () => {
	expect(metricLabel("heart_rate")).toBe("Heart rate");
	expect(metricLabel("blood_oxygen_level")).toBe("Blood oxygen level");
	expect(metricLabel("hrv")).toBe("Hrv");
});

test("a too-long field says its length and the limit", () => {
	expect(fieldErrors({ ...empty, notes: "x".repeat(4001) }).notes).toBe(
		"Notes for the physician is 4001 characters. The limit is 4000.",
	);
});

describe("formatTime", () => {
	test("a valid time is shown in the reader's locale", () => {
		const iso = "2026-03-05T14:30:00Z";
		const expected = new Date(iso).toLocaleString(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		});
		expect(formatTime(iso)).toBe(expected);
		expect(formatTime(Date.parse(iso))).toBe(expected);
	});

	test("a time that does not parse is shown as the source sent it", () => {
		expect(formatTime("last Tuesday")).toBe("last Tuesday");
	});
});
