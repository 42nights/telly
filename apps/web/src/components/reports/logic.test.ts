import { describe, expect, test } from "bun:test";
import type { FinchnodeLab } from "@health/contracts/reports";

import {
	demoText,
	draftOf,
	fieldErrors,
	fieldsOf,
	labRange,
	labValue,
	markerValue,
} from "./logic";

const empty = draftOf({
	patientName: null,
	dateOfBirth: null,
	patientId: null,
	physician: null,
	hospital: null,
	notes: null,
});

describe("report fields", () => {
	test("limits follow the contract: 200 per field, 4000 for notes", () => {
		expect(
			fieldErrors({
				...empty,
				physician: "x".repeat(200),
				notes: "x".repeat(4000),
			}),
		).toEqual({});
		const errors = fieldErrors({
			...empty,
			physician: "x".repeat(201),
			notes: "x".repeat(4001),
		});
		expect(Object.keys(errors).sort()).toEqual(["notes", "physician"]);
	});

	test("an empty box is sent as null", () => {
		expect(fieldsOf({ ...empty, physician: "  Dr. Lee " }).physician).toBe(
			"Dr. Lee",
		);
		expect(fieldsOf({ ...empty, physician: "   " }).physician).toBeNull();
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
