import { describe, expect, test } from "bun:test";
import {
	classify,
	LabCorrection,
	LabReport,
	ReferenceRange,
} from "@health/contracts/lab-report";
import { Exit, Schema } from "effect";

// Excess keys fail decoding, so nothing can ride along unseen.
const strict = { onExcessProperty: "error" } as const;
const rejects = (schema: Schema.Decoder<unknown>, input: unknown) =>
	Exit.isFailure(Schema.decodeUnknownExit(schema)(input, strict));

describe("lab report contract", () => {
	test("classify compares with the record's own range, bounds included", () => {
		const cases = [
			[1.2, 0.6, 1.2, "N"],
			[0.6, 0.6, 1.2, "N"],
			[1.21, 0.6, 1.2, "H"],
			[0.59, 0.6, 1.2, "L"],
			[39, 60, null, "L"],
			[60, 60, null, "N"],
			[5.6, null, 5.6, "N"],
			[7.1, null, 5.6, "H"],
		] as const;
		for (const [value, low, high, flag] of cases)
			expect(classify(value, { low, high, text: "range" })).toBe(flag);
	});

	test("the committed synthetic fixture decodes and stays marked synthetic", async () => {
		const json = await Bun.file(
			new URL(
				"../../../public/fixtures/lab-report.synthetic.json",
				import.meta.url,
			),
		).json();
		const report = Schema.decodeUnknownSync(LabReport)(json, strict);
		expect(report.synthetic).toBe(true);
		// No result dropped from the source's 40.
		expect(report.results.length).toBe(40);
	});

	test("a range with no bound, or with low above high, is rejected", () => {
		expect(rejects(ReferenceRange, { low: null, high: null, text: "x" })).toBe(
			true,
		);
		expect(rejects(ReferenceRange, { low: 5, high: 1, text: "x" })).toBe(true);
		expect(
			rejects(ReferenceRange, { low: 60, high: null, text: ">= 60" }),
		).toBe(false);
	});

	test("a correction needs a finite value and a reviewer name", () => {
		const valid = {
			resultId: "polypharmacy-senior-demo-lab-16",
			value: 1.6,
			correctedBy: "Priya",
			correctedAt: "2026-10-04T12:00:00.000Z",
		};
		expect(rejects(LabCorrection, valid)).toBe(false);
		for (const bad of [
			{ value: Number.NaN },
			{ value: "1.6" },
			{ correctedBy: "" },
			{ correctedBy: " Priya " },
			{ correctedAt: "Oct 4, 2026" },
		])
			expect(rejects(LabCorrection, { ...valid, ...bad })).toBe(true);
	});
});
