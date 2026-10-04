// Reads the produced PDF bytes back: structure (header, xref offsets, stream lengths, trailer),
// page count, and the text each page draws. All records are synthetic.
import { describe, expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";
import type { Report } from "@health/contracts/reports";
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
	sourceTime: "2026-10-01T08:00:00.000Z",
	receivedAt: "2026-10-01T08:00:00.000Z",
	source: "strap-a",
	synthetic: false,
	quality: "validated",
	...extra,
});

const report = (extra: Partial<Report> = {}): Report => ({
	id: "42",
	familyId: "7",
	createdBy: "a".repeat(64),
	createdAt: "2026-10-03T00:00:00.000Z",
	markers: [],
	meals: [],
	unresolved: [],
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
	...extra,
});

/** Checks the file structure and returns its pages' drawn text and line positions. */
const read = (bytes: Uint8Array) => {
	const file = Buffer.from(bytes).toString("latin1");
	expect(file.startsWith("%PDF-1.4\n")).toBe(true);
	expect(file.endsWith("%%EOF\n")).toBe(true);
	const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(file)?.[1]);
	expect(file.slice(xref, xref + 5)).toBe("xref\n");
	const size = Number(/\/Size (\d+)/.exec(file)?.[1]);
	const offsets = file
		.slice(xref)
		.split("\n")
		.slice(3, 2 + size)
		.map((row) => Number(row.slice(0, 10)));
	expect(offsets).toHaveLength(size - 1);
	offsets.forEach((offset, i) => {
		expect(file.startsWith(`${i + 1} 0 obj\n`, offset)).toBe(true);
	});
	const streams = [
		...file.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g),
	].map(([, length, body = ""]) => {
		expect(body.length).toBe(Number(length));
		return body;
	});
	const count = Number(/\/Count (\d+)/.exec(file)?.[1]);
	expect(streams).toHaveLength(count);
	const pages = streams.map((stream) =>
		stream === ""
			? []
			: stream.split("\n").map((op) => {
					const [, font, fontSize, y, text = ""] =
						/^BT \/(F[12]) (\d+) Tf 54 ([\d.-]+) Td \(((?:\\.|[^\\)])*)\) Tj ET$/.exec(
							op,
						) ?? [];
					expect(font).toBeDefined();
					return {
						bold: font === "F2",
						size: Number(fontSize),
						y: Number(y),
						raw: text,
						text: text.replace(/\\(.)/g, "$1"),
					};
				}),
	);
	const text = pages.flat().map((line) => line.text);
	return { file, pages, text, joined: text.join(" ") };
};

describe("reportPdf", () => {
	test("an empty draft is one valid page that says what is missing", () => {
		const { pages, text } = read(reportPdf(report(), madeAt));
		expect(pages).toHaveLength(1);
		expect(pages[0]?.[0]).toMatchObject({
			text: "Lab report",
			bold: true,
			size: 16,
		});
		expect(text).toContain("Layout version 2 - report 42");
		expect(text).toContain(
			"Generated 2026-10-03T00:00:00.000Z. PDF made 2026-10-04T12:00:00.000Z.",
		);
		expect(text).toContain("Draft: not reviewed. Not sent to a hospital.");
		expect(text).toContain("Name: Not filled in");
		expect(text).toContain("Hospital: Not filled in");
		expect(text).toContain("None saved.");
		expect(text).toContain("None.");
		expect(text.filter((t) => t === "None")).toHaveLength(3);
		expect(text.some((t) => t.startsWith("DEMO DATA"))).toBe(false);
		expect(text).not.toContain("Not included in this report.");
	});

	test("sections a report does not include say so", () => {
		const { text } = read(
			reportPdf(report({ meals: null, unresolved: null }), madeAt),
		);
		expect(
			text.filter((t) => t === "Not included in this report."),
		).toHaveLength(2);
	});

	test("markers, demo values, corrections, meals, and unresolved events are printed", () => {
		const { text, joined } = read(
			reportPdf(
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
						reviewedAt: "2026-10-03T10:00:00.000Z",
					},
				}),
				madeAt,
			),
		);
		expect(text).toContain(
			"DEMO DATA: 1 of 3 markers hold demo values, not real measurements.",
		);
		expect(joined).toContain(
			"Reviewed by a family member at 2026-10-03T10:00:00.000Z. This is not a clinician review. Not sent to a hospital.",
		);
		expect(text).toContain("Name: Ada");
		expect(text).toContain(
			"Resting heart rate: 62 bpm. Source strap-a, measured 2026-10-01T08:00:00.000Z, validated.",
		);
		// The correction stands indented on its own line, right after the original value.
		const corrected = text.indexOf(
			"    Corrected by a family member to 58 bpm: typing error. The value above is the original.",
		);
		expect(text[corrected - 1]).toStartWith("Resting heart rate: 62 bpm.");
		expect(joined).toContain(
			"Sleep hours: 6.5 h. Source synthetic-demo, measured 2026-10-01T08:00:00.000Z, not validated. DEMO VALUE, NOT MEASURED.",
		);
		expect(text).toContain("Spo2: Unavailable. No reading was saved.");
		expect(text).toContain(
			"A caregiver helped: cut the food, at 2026-10-02T12:00:00.000Z.",
		);
		expect(text).toContain(
			"Drink water (hydration reminder for 2026-10-02T09:00:00.000Z): unresolved.",
		);
		// The sleep marker has no correction, so only one correction line exists.
		expect(text.filter((t) => t.includes("Corrected by"))).toHaveLength(1);
	});

	test("a long correction keeps its indent on every wrapped line", () => {
		const reason = Array.from({ length: 30 }, (_, i) => `reason${i}`).join(" ");
		const { text } = read(
			reportPdf(
				report({
					markers: [{ metric: "steps", sample: sample("steps") }],
					fields: {
						...report().fields,
						corrections: [{ metric: "steps", value: 5000, reason }],
					},
				}),
				madeAt,
			),
		);
		const first = text.findIndex((t) => t.includes("Corrected by"));
		const end = text.findIndex((t) =>
			t.endsWith("The value above is the original."),
		);
		const lines = text.slice(first, end + 1);
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines) {
			expect(line).toMatch(/^ {4}\S/);
			expect(line.length).toBeLessThanOrEqual(91);
		}
		expect(lines.map((line) => line.trim()).join(" ")).toBe(
			`Corrected by a family member to 5000 bpm: ${reason}. The value above is the original.`,
		);
	});

	test("user text with a very large indent keeps every word", () => {
		const words = Array.from({ length: 20 }, (_, i) => `observation${i}`);
		const { text } = read(
			reportPdf(
				report({
					fields: {
						...report().fields,
						observations: `${" ".repeat(200)}${words.join(" ")}`,
						questions: `${" ".repeat(60)}${words.join(" ")}`,
					},
				}),
				madeAt,
			),
		);
		const observations = text.indexOf("Caregiver observations");
		const questions = text.indexOf("Questions for a clinician");
		const notes = text.indexOf("Notes for the physician");
		for (const lines of [
			text.slice(observations + 1, questions),
			text.slice(questions + 1, notes),
		]) {
			// The indent stops at half the 91-character width, so words still fit.
			for (const line of lines) {
				expect(line).toMatch(/^ {45}\S/);
				expect(line.length).toBeLessThanOrEqual(91);
			}
			expect(lines.map((line) => line.trim()).join(" ")).toBe(words.join(" "));
		}
	});

	test("PDF string delimiters are escaped and text outside WinAnsi is folded", () => {
		const { file, text, pages } = read(
			reportPdf(
				report({
					fields: {
						...report().fields,
						notes: "Dose (a) \\ b – “ok” ‘x’ wait… café 🙂 漢",
					},
				}),
				madeAt,
			),
		);
		expect(text).toContain(`Dose (a) \\ b - "ok" 'x' wait... café ? ?`);
		expect(pages.flat().find((l) => l.text.startsWith("Dose"))?.raw).toBe(
			`Dose \\(a\\) \\\\ b - "ok" 'x' wait... caf\xe9 ? ?`,
		);
		// é is one WinAnsi byte, not UTF-8.
		expect(file).toContain("caf\xe9 ");
		expect(file).not.toContain("caf\xc3\xa9");
	});

	test("long text wraps to the page width and flows onto more pages", () => {
		const paragraph = Array.from({ length: 600 }, (_, i) => `word${i}`).join(
			" ",
		);
		const long = "x".repeat(150);
		const { file, pages, text, joined } = read(
			reportPdf(
				report({
					fields: {
						...report().fields,
						observations: paragraph.slice(0, 4000),
						questions: `first line\nsecond line ${long}`,
						notes: paragraph.slice(0, 4000),
					},
				}),
				madeAt,
			),
		);
		expect(pages.length).toBeGreaterThan(1);
		expect(file).toContain(`/Count ${pages.length}`);
		// 10 pt lines hold at most 91 characters, 504 pt / (10 pt * 0.55).
		for (const line of pages.flat())
			expect(line.text.length).toBeLessThanOrEqual(
				Math.floor(504 / (line.size * 0.55)),
			);
		// Wrapping keeps every word, in order, breaking only at spaces.
		expect(joined).toContain(paragraph.slice(0, 4000));
		// A newline starts a new line; a word wider than the page is cut at the width.
		expect(text).toContain("first line");
		expect(text).toContain("second line");
		expect(text).toContain("x".repeat(91));
		expect(text).not.toContain(long);
		for (const page of pages) {
			expect(page[0]?.y).toBeCloseTo(792 - 54 - (page[0]?.size ?? 0) * 1.4, 1);
			for (const line of page) expect(line.y).toBeGreaterThan(54 - line.size);
		}
		expect(text.at(-1)).toEndWith(
			"Making it does not make an old reading current.",
		);
	});
});
