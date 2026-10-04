// A lab report as a PDF (docs/board.html#wf-lab), layout version 2. Text only, in the PDF standard
// fonts, so the file needs no font data and no library. US Letter, 0.75 in margins.
import {
	mealFactText,
	type Report,
	unresolvedText,
} from "@health/contracts/reports";

type Line = {
	readonly text: string;
	readonly bold?: boolean | undefined;
	readonly size?: number;
};

const PAGE = { width: 612, height: 792, margin: 54 };

/** WinAnsi text: common typography folded to ASCII, anything else outside Latin-1 as "?". */
const winAnsi = (text: string) =>
	text
		.replace(/[\u2013\u2014]/g, "-")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\u2026/g, "...")
		.replace(/[^\n\x20-\x7e\xa0-\xff]/gu, "?");

/**
 * Word-wraps at the width of the widest Helvetica text that fits, about 0.55 em per character. A
 * paragraph's leading spaces, at most half the width, indent each of its lines and count toward
 * the width.
 */
const wrap = ({ text, bold, size = 10 }: Line): Line[] => {
	const max = Math.floor((PAGE.width - 2 * PAGE.margin) / (size * 0.55));
	const lines: Line[] = [];
	for (const paragraph of winAnsi(text).split("\n")) {
		const words = paragraph.replace(/^ +/, "");
		const indent = " ".repeat(
			Math.min(paragraph.length - words.length, Math.floor(max / 2)),
		);
		const width = max - indent.length;
		let line = "";
		for (const word of words.split(" ")) {
			const next = line === "" ? word : `${line} ${word}`;
			if (next.length <= width) line = next;
			else {
				if (line !== "") lines.push({ text: indent + line, bold, size });
				line = word.slice(0, width);
			}
		}
		lines.push({ text: indent + line, bold, size });
	}
	return lines;
};

/** A valid PDF 1.4 file of `lines`, with as many pages as they need. */
const pdfDocument = (lines: readonly Line[]): Uint8Array => {
	const pages: string[][] = [[]];
	let y = PAGE.height - PAGE.margin;
	for (const line of lines.flatMap(wrap)) {
		const size = line.size ?? 10;
		if (y - size < PAGE.margin) {
			pages.push([]);
			y = PAGE.height - PAGE.margin;
		}
		y -= size * 1.4;
		const text = line.text.replace(/[\\()]/g, "\\$&");
		pages
			.at(-1)
			?.push(
				`BT /${line.bold ? "F2" : "F1"} ${size} Tf ${PAGE.margin} ${y.toFixed(1)} Td (${text}) Tj ET`,
			);
	}
	// Objects: 1 catalog, 2 page tree, 3 and 4 fonts, then a page and its content per page.
	const font = (name: string) =>
		`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
		font("Helvetica"),
		font("Helvetica-Bold"),
		...pages.flatMap((page, i) => {
			const stream = page.join("\n");
			return [
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`,
				`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
			];
		}),
	];
	// Every character is one Latin-1 byte, so string lengths are byte offsets.
	let file = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const offset = file.length;
		file += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return offset;
	});
	const xref = file.length;
	file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets)
		file += `${String(offset).padStart(10, "0")} 00000 n \n`;
	file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(file, "latin1"));
};

const label = (metric: string) => {
	const words = metric.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
};

const filled = (text: string | null) => text ?? "Not filled in";

/** The report as stored, with the time the PDF was made. Nothing is added or inferred. */
export const reportPdf = (report: Report, madeAt: Date): Uint8Array => {
	const { fields, markers, review } = report;
	const demo = markers.filter((m) => m.sample?.synthetic).length;
	const section = (text: string): Line => ({ text, bold: true, size: 12 });
	const lines: Line[] = [
		{ text: "Lab report", bold: true, size: 16 },
		...(demo > 0
			? [
					{
						text: `DEMO DATA: ${demo} of ${markers.length} markers hold demo values, not real measurements.`,
						bold: true,
					},
				]
			: []),
		{ text: `Layout version 2 - report ${report.id}` },
		{
			text: `Generated ${report.createdAt}. PDF made ${madeAt.toISOString()}.`,
		},
		{
			text:
				review === null
					? "Draft: not reviewed. Not sent to a hospital."
					: `Reviewed by a family member at ${review.reviewedAt}. This is not a clinician review. Not sent to a hospital.`,
		},
		section("Patient"),
		{ text: `Name: ${filled(fields.patientName)}` },
		{ text: `Date of birth: ${filled(fields.dateOfBirth)}` },
		{ text: `Patient ID: ${filled(fields.patientId)}` },
		{ text: `Physician: ${filled(fields.physician)}` },
		{ text: `Hospital: ${filled(fields.hospital)}` },
		section("Markers: the latest saved reading of each measure"),
		...markers.flatMap(({ metric, sample }): Line[] => {
			if (sample === null)
				return [
					{ text: `${label(metric)}: Unavailable. No reading was saved.` },
				];
			const correction = fields.corrections.find((c) => c.metric === metric);
			return [
				{
					text: `${label(metric)}: ${sample.value} ${sample.unit}. Source ${sample.source}, measured ${sample.sourceTime}.${sample.synthetic ? " DEMO VALUE, NOT MEASURED." : ""}`,
				},
				...(correction === undefined
					? []
					: [
							{
								text: `    Corrected by a family member to ${correction.value} ${sample.unit}: ${correction.reason}. The value above is the original.`,
							},
						]),
			];
		}),
		{ text: "Markers have no ranges or flags." },
		section("Nutrition estimates and intake reports"),
		...(report.meals === null
			? [{ text: "Not included in this report." }]
			: report.meals.length === 0
				? [{ text: "None saved." }]
				: report.meals.flatMap((meal) =>
						meal.facts.map((record) => ({ text: mealFactText(record) })),
					)),
		section("Unresolved events"),
		...(report.unresolved === null
			? [{ text: "Not included in this report." }]
			: report.unresolved.length === 0
				? [{ text: "None." }]
				: report.unresolved.map((detail) => ({
						text: unresolvedText(detail),
					}))),
		section("Caregiver observations"),
		{ text: fields.observations ?? "None" },
		section("Questions for a clinician"),
		{ text: fields.questions ?? "None" },
		section("Notes for the physician"),
		{ text: fields.notes ?? "None" },
		{ text: "" },
		{
			text: "This report lists readings that were already saved. It is not a new lab test and not medical advice. Making it does not make an old reading current.",
			bold: true,
		},
	];
	return pdfDocument(lines);
};
