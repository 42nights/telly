import type { HealthSample } from "@health/contracts";
import {
	mealFactText,
	type Report,
	type ReportCorrection,
	type ReportMarker,
	unresolvedText,
} from "@health/contracts/reports";
import {
	PDFDocument,
	type PDFFont,
	type PDFPage,
	rgb,
	StandardFonts,
} from "pdf-lib";

const PAGE = { width: 612, height: 792, margin: 54 };
const WIDTH = PAGE.width - 2 * PAGE.margin;
const RULE = rgb(0.6, 0.6, 0.6);
const SHADE = rgb(0.92, 0.92, 0.92);
const LINE = rgb(0.1, 0.3, 0.6);

const winAnsi = (text: string) =>
	text
		.replace(/[–—]/g, "-")
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/…/g, "...")
		.replace(/[^\n\x20-\x7e\xa0-\xff]/gu, "?");

const wrap = (text: string, font: PDFFont, size: number, width: number) => {
	const fits = (line: string) => font.widthOfTextAtSize(line, size) <= width;
	const pieces = (word: string) => {
		const parts: string[] = [];
		let part = "";
		for (const char of word) {
			if (part !== "" && !fits(part + char)) {
				parts.push(part);
				part = "";
			}
			part += char;
		}
		return [...parts, part];
	};
	return winAnsi(text)
		.split("\n")
		.flatMap((paragraph) => {
			const lines: string[] = [];
			let line = "";
			for (const piece of paragraph
				.split(" ")
				.filter((word) => word !== "")
				.flatMap(pieces)) {
				const next = line === "" ? piece : `${line} ${piece}`;
				if (fits(next)) line = next;
				else {
					lines.push(line);
					line = piece;
				}
			}
			return [...lines, line];
		});
};

const time = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const label = (metric: string) => {
	const words = metric.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
};

const filled = (text: string | null) => text ?? "Not filled in";

const listed = (items: readonly string[] | null, empty: string) =>
	items === null
		? ["Not included in this report."]
		: items.length === 0
			? [empty]
			: items.map((item) => `- ${item}`);

const markerRow = (
	{ metric, sample }: ReportMarker,
	corrections: readonly ReportCorrection[],
) => {
	if (sample === null)
		return [label(metric), "Unavailable: no reading was saved", "", "", "", ""];
	const correction = corrections.find((c) => c.metric === metric);
	return [
		label(metric),
		[
			String(sample.value),
			...(sample.synthetic ? ["Demo value, not measured"] : []),
			...(correction === undefined
				? []
				: [
						`Corrected by a family member to ${correction.value}: ${correction.reason}. The value above is the original.`,
					]),
		].join("\n"),
		sample.unit,
		time(sample.sourceTime),
		sample.source,
		sample.quality,
	];
};

type Sheet = {
	readonly doc: PDFDocument;
	readonly regular: PDFFont;
	readonly bold: PDFFont;
	page: PDFPage;
	y: number;
};

const room = (sheet: Sheet, height: number) => {
	if (sheet.y - height >= PAGE.margin) return false;
	sheet.page = sheet.doc.addPage([PAGE.width, PAGE.height]);
	sheet.y = PAGE.height - PAGE.margin;
	return true;
};

const write = (sheet: Sheet, value: string, bold = false, size = 10) => {
	const font = bold ? sheet.bold : sheet.regular;
	for (const line of wrap(value, font, size, WIDTH)) {
		room(sheet, size * 1.4);
		sheet.y -= size * 1.4;
		sheet.page.drawText(line, { x: PAGE.margin, y: sheet.y, size, font });
	}
};

const heading = (sheet: Sheet, value: string) => {
	room(sheet, 48);
	sheet.y -= 8;
	write(sheet, value, true, 12);
	sheet.y -= 2;
};

const tableRow = (
	sheet: Sheet,
	widths: readonly number[],
	cells: readonly string[],
	bold: boolean,
) => {
	const font = bold ? sheet.bold : sheet.regular;
	const lines = cells.map((cell, i) =>
		wrap(cell, font, 9, (widths[i] ?? 0) - 8),
	);
	const height = Math.max(...lines.map((l) => l.length)) * 11 + 6;
	const draw = () => {
		const { page } = sheet;
		sheet.y -= height;
		if (bold)
			page.drawRectangle({
				x: PAGE.margin,
				y: sheet.y,
				width: WIDTH,
				height,
				color: SHADE,
			});
		page.drawLine({
			start: { x: PAGE.margin, y: sheet.y },
			end: { x: PAGE.margin + WIDTH, y: sheet.y },
			thickness: 0.5,
			color: RULE,
		});
		let x = PAGE.margin;
		lines.forEach((cell, i) => {
			cell.forEach((line, n) => {
				page.drawText(line, {
					x: x + 4,
					y: sheet.y + height - 12 - n * 11,
					size: 9,
					font,
				});
			});
			x += widths[i] ?? 0;
		});
	};
	return { height, draw };
};

const table = (
	sheet: Sheet,
	widths: readonly number[],
	header: readonly string[],
	rows: readonly (readonly string[])[],
) => {
	const head = tableRow(sheet, widths, header, true);
	rows.forEach((cells, i) => {
		const row = tableRow(sheet, widths, cells, false);
		if (room(sheet, row.height + (i === 0 ? head.height : 0)) || i === 0)
			head.draw();
		row.draw();
	});
};

const chartLabel = (sheet: Sheet, text: string, x: number, y: number) =>
	sheet.page.drawText(text, { x, y, size: 8, font: sheet.regular });

const chart = (sheet: Sheet, samples: readonly HealthSample[]) => {
	const first = samples[0];
	const last = samples.at(-1);
	if (first === undefined || last === undefined || samples.length < 2) return;
	room(sheet, 180);
	heading(
		sheet,
		`Resting heart rate (${first.unit}), ${samples.length} readings from ${first.source}, 30 days before the report${samples.some((s) => s.synthetic) ? " - DEMO VALUES, NOT MEASURED" : ""}`,
	);
	const box = { x: PAGE.margin + 30, width: WIDTH - 40, height: 110 };
	const bottom = sheet.y - box.height - 14;
	const values = samples.map((s) => s.value);
	const low = Math.min(...values);
	const high = Math.max(...values);
	const start = Date.parse(first.sourceTime);
	const span = Date.parse(last.sourceTime) - start || 1;
	const point = (s: HealthSample) => ({
		x: box.x + ((Date.parse(s.sourceTime) - start) / span) * box.width,
		y: bottom + ((s.value - low) / (high - low || 1)) * box.height,
	});
	const axis = { start: { x: box.x, y: bottom }, thickness: 0.75, color: RULE };
	sheet.page.drawLine({ ...axis, end: { x: box.x + box.width, y: bottom } });
	sheet.page.drawLine({ ...axis, end: { x: box.x, y: bottom + box.height } });
	const width = (text: string) => sheet.regular.widthOfTextAtSize(text, 8);
	chartLabel(
		sheet,
		String(high),
		box.x - 4 - width(String(high)),
		bottom + box.height - 3,
	);
	chartLabel(sheet, String(low), box.x - 4 - width(String(low)), bottom - 3);
	chartLabel(sheet, time(first.sourceTime), box.x, bottom - 12);
	const end = time(last.sourceTime);
	chartLabel(sheet, end, box.x + box.width - width(end), bottom - 12);
	samples.forEach((sample, i) => {
		const before = samples[i - 1];
		if (before !== undefined)
			sheet.page.drawLine({
				start: point(before),
				end: point(sample),
				thickness: 1.25,
				color: LINE,
			});
		sheet.page.drawCircle({ ...point(sample), size: 1.75, color: LINE });
	});
	sheet.y = bottom - 20;
};

const header = (sheet: Sheet, report: Report, madeAt: Date) => {
	const { markers, review } = report;
	const demo = markers.filter((m) => m.sample?.synthetic).length;
	write(sheet, "Lab report", true, 18);
	sheet.y -= 4;
	if (demo > 0)
		write(
			sheet,
			`DEMO DATA: ${demo} of ${markers.length} markers hold demo values, not real measurements.`,
			true,
		);
	write(
		sheet,
		`Report ${report.id} - family ${report.familyId} - layout version 3`,
	);
	write(
		sheet,
		`Created ${time(report.createdAt)} by family member ${report.createdBy}`,
	);
	write(
		sheet,
		review === null
			? "Draft: not reviewed by a family member."
			: `Reviewed ${time(review.reviewedAt)} by family member ${review.reviewedBy}. A family review is not a clinician review.`,
	);
	write(sheet, `PDF made ${time(madeAt.toISOString())}`);
};

const sections = (sheet: Sheet, report: Report) => {
	const { fields } = report;
	for (const [title, lines] of [
		[
			"Nutrition estimates and intake reports",
			listed(
				report.meals?.flatMap((meal) => meal.facts.map(mealFactText)) ?? null,
				"None saved.",
			),
		],
		[
			"Unresolved events",
			listed(report.unresolved?.map(unresolvedText) ?? null, "None."),
		],
		["Caregiver observations", [fields.observations ?? "None"]],
		["Questions for a clinician", [fields.questions ?? "None"]],
		["Notes for the physician", [fields.notes ?? "None"]],
	] as const) {
		heading(sheet, title);
		for (const line of lines) write(sheet, line);
	}
};

export const reportPdf = async (
	report: Report,
	madeAt: Date,
): Promise<Uint8Array> => {
	const { fields } = report;
	const doc = await PDFDocument.create();
	doc.setTitle(`Lab report ${report.id}`);
	doc.setCreationDate(madeAt);
	doc.setModificationDate(madeAt);
	const regular = await doc.embedFont(StandardFonts.Helvetica);
	const sheet: Sheet = {
		doc,
		regular,
		bold: await doc.embedFont(StandardFonts.HelveticaBold),
		page: doc.addPage([PAGE.width, PAGE.height]),
		y: PAGE.height - PAGE.margin,
	};

	header(sheet, report, madeAt);
	heading(sheet, "Patient and hospital");
	table(
		sheet,
		[150, WIDTH - 150],
		["Field", "As filled in by the family"],
		[
			["Name", filled(fields.patientName)],
			["Date of birth", filled(fields.dateOfBirth)],
			["Patient ID", filled(fields.patientId)],
			["Physician", filled(fields.physician)],
			["Hospital", filled(fields.hospital)],
		],
	);
	chart(sheet, report.restingHeartRate ?? []);
	heading(sheet, "Markers: the latest saved reading of each measure");
	table(
		sheet,
		[96, 128, 52, 76, 92, 60],
		["Metric", "Value", "Unit", "Measured", "Source", "Quality"],
		report.markers.map((marker) => markerRow(marker, fields.corrections)),
	);
	write(sheet, "Markers have no ranges or flags.");
	sections(sheet, report);
	sheet.y -= 10;
	write(
		sheet,
		"A family review is not a clinician review. This report lists readings that were already saved. It is not a new lab test and not medical advice. Making it does not make an old reading current.",
		true,
	);

	const pages = doc.getPages();
	pages.forEach((page, i) => {
		const number = `Page ${i + 1} of ${pages.length}`;
		page.drawText(number, {
			x: (PAGE.width - regular.widthOfTextAtSize(number, 8)) / 2,
			y: PAGE.margin / 2,
			size: 8,
			font: regular,
		});
	});
	return doc.save();
};
