import { describe, expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";
import type { Report } from "@health/contracts/reports";
import {
	decodePDFRawStream,
	PDFArray,
	PDFDocument,
	PDFRawStream,
	StandardFonts,
} from "pdf-lib";
import { reportPdf } from "./report-pdf";

const madeAt = new Date("2026-10-04T12:00:00.000Z");

const sample = (
	metric: string,
	extra: Partial<HealthSample> = {},
): HealthSample => ({
	id: "1",
	familyId: "7",
	metric,
	value: 62,
	unit: "bpm",
	sourceTime: "2026-10-01T08:00:00.000000Z",
	receivedAt: "2026-10-01T08:00:00.000000Z",
	source: "strap-a",
	synthetic: false,
	quality: "validated",
	...extra,
});

const report = (extra: Partial<Report> = {}): Report => ({
	id: "42",
	familyId: "7",
	createdBy: "a".repeat(64),
	createdAt: "2026-10-03T00:00:00.000000Z",
	markers: [],
	meals: [],
	unresolved: [],
	restingHeartRate: [],
	fields: {
		patientName: null,
		dateOfBirth: null,
		patientId: null,
		physician: null,
		hospital: null,
		notes: null,
		observations: null,
		questions: null,
		corrections: [],
	},
	review: null,
	email: null,
	...extra,
});

const read = async (report: Report) => {
	const doc = await PDFDocument.load(await reportPdf(report, madeAt));
	const pages = doc.getPages().map((page) => {
		const contents = page.node.Contents();
		const ops = (contents instanceof PDFArray ? contents.asArray() : [])
			.map((ref) => {
				const stream = doc.context.lookup(ref);
				if (!(stream instanceof PDFRawStream)) throw new Error("no stream");
				return Buffer.from(decodePDFRawStream(stream).decode()).toString(
					"latin1",
				);
			})
			.join("\n");
		return [
			...ops.matchAll(
				/\/(\S+) ([\d.]+) Tf\n[^\n]*\n1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\n<([0-9A-F]*)> Tj/g,
			),
		].map(([, font = "", size, x, y, hex = ""]) => ({
			bold: font.startsWith("Helvetica-Bold"),
			size: Number(size),
			x: Number(x),
			y: Number(y),
			text: Buffer.from(hex, "hex").toString("latin1"),
		}));
	});
	const text = pages.flatMap((runs) => runs.slice(0, -1).map((r) => r.text));
	const numbers = pages.map((runs) => runs.at(-1)?.text);
	return { doc, pages, numbers, text, joined: text.join(" ") };
};

describe("reportPdf", () => {
	test("a reviewed report prints its header, fields, markers, daily records, notes, and disclaimer", async () => {
		const { doc, numbers, text, joined } = await read(
			report({
				markers: [
					{
						metric: "resting_heart_rate",
						sample: sample("resting_heart_rate"),
					},
					{
						metric: "sleep_hours",
						sample: sample("sleep_hours", {
							value: 6.5,
							unit: "h",
							synthetic: true,
							quality: "unvalidated",
							source: "synthetic-demo",
						}),
					},
					{ metric: "spo2", sample: null },
				],
				restingHeartRate: [
					sample("resting_heart_rate", {
						value: 60,
						sourceTime: "2026-09-30T08:00:00.000000Z",
					}),
					sample("resting_heart_rate"),
				],
				meals: [
					{
						mealId: "m1",
						intake: "reported",
						facts: [
							{
								id: "5",
								fact: { type: "caregiver_assistance", help: "cut the food" },
								recordedBy: "b".repeat(64),
								recordedAt: "2026-10-02T12:00:00.000Z",
							},
						],
					},
				],
				unresolved: [
					{
						occurrence: {
							id: "9",
							reminderId: "3",
							familyId: "7",
							kind: "hydration",
							subjectId: null,
							title: "Drink water",
							scheduledFor: "2026-10-02T09:00:00.000Z",
							state: "delivered",
							promptDue: false,
							prompts: 1,
							nextPromptAt: null,
						},
						events: [],
					},
				],
				fields: {
					...report().fields,
					patientName: "Ada",
					hospital: "Synthetic General",
					questions: "Is this trend a concern?",
					corrections: [
						{
							metric: "resting_heart_rate",
							value: 58,
							reason: "typing error",
						},
					],
				},
				review: {
					reviewedBy: "c".repeat(64),
					reviewedAt: "2026-10-03T10:00:00.000000Z",
				},
			}),
		);
		expect(doc.getTitle()).toBe("Lab report 42");
		expect(text.slice(0, 3)).toEqual([
			"Lab report",
			"DEMO DATA: 1 of 3 markers hold demo values, not real measurements.",
			"Report 42 - family 7 - layout version 3",
		]);
		expect(joined).toContain(
			`Reviewed 2026-10-03 10:00 UTC by family member ${"c".repeat(64)}. A family review is not a clinician review.`,
		);
		expect(joined).toContain("PDF made 2026-10-04 12:00 UTC");
		expect(joined).toContain("Name Ada");
		expect(joined).toContain("Hospital Synthetic General");
		expect(joined).toContain("Physician Not filled in");
		expect(joined).toContain(
			"Resting heart rate (bpm), 2 readings from strap-a, 30 days before the report",
		);
		expect(joined).toContain(
			"Metric Value Unit Measured Source Quality Resting heart rate 62",
		);
		expect(joined).toContain(
			"Corrected by a family member to 58: typing error. The value above is the original. bpm 2026-10-01 08:00 UTC strap-a validated",
		);
		expect(joined).toContain(
			"Sleep hours 6.5 Demo value, not measured h 2026-10-01 08:00 UTC synthetic-demo unvalidated",
		);
		expect(joined).toContain("Spo2 Unavailable: no reading was saved");
		expect(text).toContain(
			"- A caregiver helped: cut the food, at 2026-10-02T12:00:00.000Z.",
		);
		expect(text).toContain(
			"- Drink water (hydration reminder for 2026-10-02T09:00:00.000Z): unresolved.",
		);
		expect(text).toContain("Is this trend a concern?");
		expect(joined).toContain(
			"A family review is not a clinician review. This report lists readings that were already saved. It is not a new lab test and not medical advice.",
		);
		expect(numbers).toEqual(["Page 1 of 2", "Page 2 of 2"]);
	});

	test("a draft says what is missing, and one reading draws no chart", async () => {
		const { text } = await read(
			report({
				meals: null,
				unresolved: null,
				restingHeartRate: [sample("resting_heart_rate")],
			}),
		);
		expect(text).toContain("Draft: not reviewed by a family member.");
		expect(text).toContain("Not filled in");
		expect(
			text.filter((t) => t === "Not included in this report."),
		).toHaveLength(2);
		expect(text.filter((t) => t === "None")).toHaveLength(3);
		expect(text.some((t) => t.startsWith("Resting heart rate ("))).toBe(false);
		expect(text.some((t) => t.startsWith("DEMO DATA"))).toBe(false);
	});

	test("long text wraps inside the margins, keeps every word, and flows onto numbered pages", async () => {
		const paragraph = Array.from({ length: 600 }, (_, i) => `word${i}`).join(
			" ",
		);
		const long = "x".repeat(150);
		const { pages, numbers, joined } = await read(
			report({
				fields: {
					...report().fields,
					observations: paragraph.slice(0, 4000),
					questions: `first line\nsecond line ${long}`,
					notes: `Dose (a) \\ b – “ok” ‘x’ wait… café 🙂 漢 ${paragraph.slice(0, 4000)}`,
				},
			}),
		);
		expect(pages.length).toBeGreaterThan(1);
		const fonts = await PDFDocument.create();
		const regular = await fonts.embedFont(StandardFonts.Helvetica);
		const bold = await fonts.embedFont(StandardFonts.HelveticaBold);
		expect(numbers).toEqual(
			pages.map((_, i) => `Page ${i + 1} of ${pages.length}`),
		);
		for (const runs of pages)
			for (const run of runs) {
				const width = (run.bold ? bold : regular).widthOfTextAtSize(
					run.text,
					run.size,
				);
				expect(run.x).toBeGreaterThanOrEqual(54);
				expect(run.x + width).toBeLessThanOrEqual(612 - 54);
				expect(run.y).toBeGreaterThanOrEqual(54 / 2);
			}
		expect(joined).toContain(paragraph.slice(0, 4000));
		expect(joined).toContain("first line second line");
		expect(joined.replace(/ /g, "")).toContain(long);
		expect(joined).toContain(`Dose (a) \\ b - "ok" 'x' wait... café ? ?`);
	});
});
