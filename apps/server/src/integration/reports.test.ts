// Proves the lab report path a family takes: the creator signs in, makes a family, saves readings,
// generates a report from them, fills and reviews it, saves it as a PDF, lists it, and downloads
// it through the server's link. Another member sees the report but not the creator's private PDF; a
// signed-in non-member is refused. Real server and SpacetimeDB; only the issuer and R2 are fake.
import { describe, expect, test } from "bun:test";
import { HealthSample } from "@health/contracts";
import {
	Report,
	ReportPdf,
	ReportPdfLink,
	ReportPdfs,
	Reports,
} from "@health/contracts/reports";
import { PDFDocument } from "pdf-lib";
import {
	addMember,
	createFamily,
	errorOf,
	integration,
	json,
	shareHealthRecords,
	startIntegration,
	type User,
} from "./harness";

const it = integration ? await startIntegration() : undefined;

describe.skipIf(!it)("lab report flow", () => {
	const run = crypto.randomUUID();
	let owner: User;
	let path: string;
	let familyId: string;
	let report: Report;
	let pdf: ReportPdf;
	let key: string;

	test("the creator generates a report from the readings they saved", async () => {
		if (!it) return;
		owner = await it.signIn(`reports-owner-${run}`);
		const family = await createFamily(owner, "Reports");
		path = family.path;
		familyId = family.id;
		for (const [metric, value, unit] of [
			["hrv", 41, "ms"],
			["spo2", 97, "%"],
		] as const) {
			const saved = await json(
				HealthSample,
				await owner.call("POST", `${path}/samples`, {
					metric,
					value,
					unit,
					sourceTime: "2026-10-01T08:00:00Z",
					source: "integration",
					synthetic: false,
					quality: "validated",
				}),
			);
			expect(saved).toMatchObject({ metric, value, unit });
		}

		const created = await owner.call("POST", `${path}/reports`);
		expect(created.status).toBe(201);
		report = await json(Report, created);
		expect(report.createdBy).toBe(owner.identity);
		expect(report.review).toBeNull();
		const marker = (metric: string) =>
			report.markers.find((m) => m.metric === metric)?.sample ?? null;
		expect(marker("hrv")).toMatchObject({ value: 41, unit: "ms" });
		expect(marker("spo2")).toMatchObject({ value: 97, unit: "%" });
		// Missing data stays missing: no reading means no value.
		expect(marker("resting_heart_rate")).toBeNull();

		const listed = await json(
			Reports,
			await owner.call("GET", `${path}/reports`),
		);
		expect(listed.reports.map((r) => r.id)).toEqual([report.id]);
	});

	test("the creator fills in the patient and reviews the report", async () => {
		if (!it) return;
		const filled = await json(
			Report,
			await owner.call("POST", `${path}/reports/${report.id}/fields`, {
				...report.fields,
				patientName: "Rosa Rivera",
				questions: "Is the low HRV a concern?",
			}),
		);
		expect(filled.fields.patientName).toBe("Rosa Rivera");
		report = await json(
			Report,
			await owner.call("POST", `${path}/reports/${report.id}/review`),
		);
		expect(report.review?.reviewedBy).toBe(owner.identity);
		// A reviewed report no longer changes.
		const late = await owner.call(
			"POST",
			`${path}/reports/${report.id}/fields`,
			report.fields,
		);
		expect(await errorOf(late)).toEqual([409, "conflict"]);
	});

	test("the creator saves the report as a PDF in storage (#190: R2 set means no `unavailable`)", async () => {
		if (!it) return;
		const made = await owner.call("POST", `${path}/reports/${report.id}/pdfs`);
		expect(made.status).not.toBe(503);
		expect(made.status).toBe(201);
		pdf = await json(ReportPdf, made);
		expect(pdf.reportId).toBe(report.id);

		key = `report-pdfs/${familyId}/${owner.identity}/${pdf.id}.pdf`;
		const stored = it.bucket.get(key);
		expect(stored?.type).toBe("application/pdf");
		const body = stored?.body ?? new Uint8Array();
		expect(body.length).toBe(pdf.bytes);
		expect(new TextDecoder("latin1").decode(body.slice(0, 5))).toBe("%PDF-");
		expect((await PDFDocument.load(body)).getTitle()).toBe(
			`Lab report ${report.id}`,
		);
	});

	test("the creator finds the PDF in past PDFs and downloads the same bytes", async () => {
		if (!it) return;
		const past = await json(
			ReportPdfs,
			await owner.call("GET", `${path}/report-pdfs`),
		);
		expect(past.pdfs).toEqual([{ ...pdf, createdAt: expect.any(String) }]);

		const link = await json(
			ReportPdfLink,
			await owner.call("GET", `${path}/report-pdfs/${pdf.id}`),
		);
		const url = new URL(link.url);
		expect(url.origin).toBe(it.issuer);
		expect(decodeURIComponent(url.pathname)).toBe(`/telly-integration/${key}`);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
		expect(url.searchParams.get("response-content-disposition")).toBe(
			`attachment; filename="lab-report-${pdf.id.slice(0, 8)}.pdf"`,
		);
		expect(
			new URL(link.viewUrl).searchParams.get("response-content-disposition"),
		).toBe(`inline; filename="lab-report-${pdf.id.slice(0, 8)}.pdf"`);
		expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
		const downloaded = await fetch(link.url);
		expect(downloaded.status).toBe(200);
		const bytes: Uint8Array = new Uint8Array(await downloaded.arrayBuffer());
		expect(bytes).toEqual(it.bucket.get(key)?.body ?? new Uint8Array());
	});

	test("a family member with health records sees the report but not the creator's private PDF", async () => {
		if (!it) return;
		const relative = await it.signIn(`reports-relative-${run}`);
		await addMember(owner, path, relative);
		await shareHealthRecords(owner, path, relative);

		const listed = await json(
			Reports,
			await relative.call("GET", `${path}/reports`),
		);
		expect(listed.reports.map((r) => r.id)).toEqual([report.id]);
		const seen = await json(
			Report,
			await relative.call("GET", `${path}/reports/${report.id}`),
		);
		expect(seen).toEqual(report);

		// A PDF belongs to the member who made it; another's reads exactly like a missing one.
		const taken = await relative.call("GET", `${path}/report-pdfs/${pdf.id}`);
		expect(await errorOf(taken)).toEqual([404, "not_found"]);
		const theirs = await json(
			ReportPdfs,
			await relative.call("GET", `${path}/report-pdfs`),
		);
		expect(theirs.pdfs).toEqual([]);
	});

	test("a signed-in non-member cannot read the report or touch its PDFs", async () => {
		if (!it) return;
		const outsider = await it.signIn(`reports-outsider-${run}`);
		const objects = it.bucket.size;
		for (const [method, route] of [
			["GET", "/reports"],
			["GET", `/reports/${report.id}`],
			["POST", "/reports"],
			["POST", `/reports/${report.id}/pdfs`],
			["GET", `/report-pdfs/${pdf.id}`],
		] as const) {
			const refused = await outsider.call(method, `${path}${route}`);
			expect([route, ...(await errorOf(refused))]).toEqual([
				route,
				403,
				"forbidden",
			]);
		}
		expect(it.bucket.size).toBe(objects);
	});
});
