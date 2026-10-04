// Lab report routes (docs/board.html#wf-lab), mounted at `/api/families/:familyId`. The module's
// reducers check membership and the review lock again, so these handlers add no access rule.
import type { HealthSample } from "@health/contracts";
import {
	type Report,
	type ReportEmail,
	ReportEmailSettings,
	ReportFields,
	ReportMarker,
	type ReportPdf,
	type ReportPdfLink,
	type ReportPdfs,
	type Reports,
} from "@health/contracts/reports";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { readFamilyRecords } from "../db";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import type { R2Bucket } from "../integrations/r2";
import type { Mailer } from "../integrations/resend";
import { reportPdf } from "../report-pdf";

/** The marker rows of the board's lab report (docs/board.html#lab-table), always listed. */
const layout = [
	"hrv",
	"resting_heart_rate",
	"sleep_duration",
	"spo2",
	"respiratory_rate",
	"falls",
];

const Markers = Schema.fromJsonString(Schema.Array(ReportMarker));
const Fields = Schema.fromJsonString(ReportFields);
const emptyFields: ReportFields = {
	patientName: null,
	dateOfBirth: null,
	patientId: null,
	physician: null,
	hospital: null,
	notes: null,
	observations: null,
	questions: null,
	corrections: [],
};

/**
 * One marker per layout metric and per other metric the family has: its latest sample by source
 * time, or `null` when there is none. Missing data stays missing; nothing is filled in.
 */
const generateMarkers = (samples: readonly HealthSample[]): ReportMarker[] => {
	const latest = new Map<string, HealthSample>();
	for (const sample of samples) {
		const seen = latest.get(sample.metric);
		// Database times share one fixed-width UTC format, so they order as strings.
		if (seen === undefined || sample.sourceTime > seen.sourceTime)
			latest.set(sample.metric, sample);
	}
	return [...new Set([...layout, ...latest.keys()])].map((metric) => ({
		metric,
		sample: latest.get(metric) ?? null,
	}));
};

const readEmails = (c: Context<FamilyEnv>) =>
	new Map(
		[...c.var.db.connection.db.myReportEmails.iter()].map((row) => [
			row.reportId,
			row,
		]),
	);

export const readReports = (c: Context<FamilyEnv>): Report[] => {
	const emails = readEmails(c);
	return [...c.var.db.connection.db.myReports.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.map((row) => {
			const email = emails.get(row.id);
			return {
				id: row.id,
				familyId: row.familyId.toString(),
				createdBy: row.createdBy.toHexString(),
				createdAt: row.createdAt.toISOString(),
				markers: Schema.decodeUnknownSync(Markers)(row.markers),
				fields: Schema.decodeUnknownSync(Fields)(row.fields),
				review:
					row.reviewedBy === undefined || row.reviewedAt === undefined
						? null
						: {
								reviewedBy: row.reviewedBy.toHexString(),
								reviewedAt: row.reviewedAt.toISOString(),
							},
				email:
					email === undefined
						? null
						: {
								// The module writes only `ReportEmail` statuses.
								status: email.status as ReportEmail["status"],
								recipient: email.recipient,
								reason: email.reason ?? null,
								automatic: email.automatic,
								updatedAt: email.updatedAt.toISOString(),
							},
			};
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

const readEmailSettings = (c: Context<FamilyEnv>): ReportEmailSettings => {
	const row = [...c.var.db.connection.db.myReportEmailSettings.iter()].find(
		(s) => s.familyId === c.var.familyId,
	);
	return {
		enabled: row?.enabled ?? false,
		recipient: row?.recipient || null,
	};
};

const findReport = (c: Context<FamilyEnv>, id = c.req.param("reportId")) => {
	const report = readReports(c).find((row) => row.id === id);
	if (report === undefined)
		throw new ApiFailure("not_found", "No such report in this family");
	return report;
};

// Report PDFs live under a key that the server builds from the verified caller, never from the
// request: `report-pdfs/<familyId>/<caller identity>/<reportId>.<uuid>.pdf`. The family middleware
// has already checked membership, so a caller reaches only their own PDFs in their own families.
const pdfPrefix = (c: Context<FamilyEnv>) =>
	`report-pdfs/${c.var.familyId}/${c.var.db.identity}/`;
const PDF_ID = /^[0-9a-f-]{36}\.[0-9a-f-]{36}$/;

const needStorage = (storage: R2Bucket | undefined) => {
	if (storage === undefined)
		throw new ApiFailure(
			"unavailable",
			"PDF storage is not set up on this server",
		);
	return storage;
};

/**
 * Queues an email of a reviewed report, sends it with the PDF attached, and records the result. The
 * module decides whether anything is queued: an automatic send happens once per report, and only
 * while the setting is on. Only the attempt whose `sendId` the module stored sends.
 */
const emailReport = async (
	c: Context<FamilyEnv>,
	reportId: string,
	automatic: boolean,
	mailer: Mailer | undefined,
) => {
	const { db } = c.var;
	const sendId = crypto.randomUUID();
	await callReducer(db, (connection) =>
		connection.reducers.queueReportEmail({ reportId, sendId, automatic }),
	);
	if (readEmails(c).get(reportId)?.sendId !== sendId) return;
	const report = findReport(c, reportId);
	let failure: string | undefined;
	if (mailer === undefined) failure = "Email is not set up on this server";
	else
		try {
			await mailer({
				to: report.email?.recipient ?? "",
				subject: "Reviewed lab report from Telly",
				text: [
					`A family member marked this lab report as reviewed on ${report.review?.reviewedAt ?? ""}.`,
					"The report is attached as a PDF.",
					"A family review is not a clinician review. Nothing in this report is medical advice.",
				].join("\n\n"),
				attachment: {
					filename: `lab-report-${report.id.slice(0, 8)}.pdf`,
					content: reportPdf(report, new Date()),
				},
				idempotencyKey: sendId,
			});
		} catch (error) {
			failure = error instanceof Error ? error.message : "The email failed";
		}
	await callReducer(db, (connection) =>
		connection.reducers.settleReportEmail({ reportId, sendId, failure }),
	);
};

/** The report flow: generate a draft, fill it, review it, then submit or email it. */
export const reportRoutes = (storage?: R2Bucket, mailer?: Mailer) =>
	new Hono<FamilyEnv>()
		.get("/report-email", (c) =>
			c.json(readEmailSettings(c) satisfies ReportEmailSettings),
		)
		.put("/report-email", async (c) => {
			const { enabled, recipient } = await decodeBody(c, ReportEmailSettings);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.setReportEmailSettings({
					familyId: c.var.familyId,
					enabled,
					recipient: recipient ?? "",
				}),
			);
			return c.json(readEmailSettings(c) satisfies ReportEmailSettings);
		})
		.get("/reports", (c) =>
			c.json({ reports: readReports(c) } satisfies Reports),
		)
		.post("/reports", async (c) => {
			const { db, familyId } = c.var;
			const id = crypto.randomUUID();
			const samples = readFamilyRecords(db).samples.filter(
				(sample) => sample.familyId === familyId.toString(),
			);
			await callReducer(db, (connection) =>
				connection.reducers.createReport({
					id,
					familyId,
					markers: Schema.encodeSync(Markers)(generateMarkers(samples)),
					fields: Schema.encodeSync(Fields)(emptyFields),
				}),
			);
			return c.json(findReport(c, id) satisfies Report, 201);
		})
		.get("/reports/:reportId", (c) => c.json(findReport(c) satisfies Report))
		.post("/reports/:reportId/fields", async (c) => {
			const fields = await decodeBody(c, ReportFields);
			const report = findReport(c);
			if (report.review !== null)
				throw new ApiFailure("conflict", "A reviewed report cannot change");
			const measured = report.markers.filter((m) => m.sample !== null);
			for (const { metric } of fields.corrections)
				if (!measured.some((m) => m.metric === metric))
					throw new ApiFailure(
						"invalid_request",
						`No measured ${metric} marker to correct`,
					);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.updateReport({
					id: report.id,
					fields: Schema.encodeSync(Fields)(fields),
					review: false,
				}),
			);
			return c.json(findReport(c) satisfies Report);
		})
		.post("/reports/:reportId/review", async (c) => {
			const { id, review } = findReport(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.updateReport({
					id,
					fields: undefined,
					review: true,
				}),
			);
			// Only the review that froze the draft emails it; reviewing again sends nothing.
			if (review === null) await emailReport(c, id, true, mailer);
			return c.json(findReport(c) satisfies Report);
		})
		.post("/reports/:reportId/email", async (c) => {
			const { id } = findReport(c);
			if (mailer === undefined)
				throw new ApiFailure(
					"unavailable",
					"Email is not set up on this server",
				);
			await emailReport(c, id, false, mailer);
			return c.json(findReport(c) satisfies Report);
		})
		.post("/reports/:reportId/submit", (c) => {
			if (findReport(c).review === null)
				throw new ApiFailure(
					"conflict",
					"Review the report before you submit it",
				);
			// FinchNode is a read-only, patient-authorized EHR API: "It reads records. It never writes
			// back to a health system" (https://finchnode.com/docs). Its API reference
			// (https://finchnode.com/docs/api, contract 2026-09-22) has no operation that delivers a
			// report to a hospital, so hospital delivery stays unavailable until #8 picks a real path.
			throw new ApiFailure(
				"unavailable",
				"Hospital delivery is unavailable: Finchnode has no report delivery API",
			);
		})
		.post("/reports/:reportId/pdfs", async (c) => {
			const bucket = needStorage(storage);
			const report = findReport(c);
			const madeAt = new Date();
			const id = `${report.id}.${crypto.randomUUID()}`;
			const pdf = reportPdf(report, madeAt);
			await bucket.put(`${pdfPrefix(c)}${id}.pdf`, pdf, "application/pdf");
			return c.json(
				{
					id,
					reportId: report.id,
					createdAt: madeAt.toISOString(),
					bytes: pdf.length,
				} satisfies ReportPdf,
				201,
			);
		})
		.get("/report-pdfs", async (c) => {
			const prefix = pdfPrefix(c);
			const pdfs = (await needStorage(storage).list(prefix))
				.map(({ key, size, lastModified }) => {
					const id = key.slice(prefix.length, -".pdf".length);
					return {
						id,
						reportId: id.split(".")[0] ?? "",
						createdAt: new Date(lastModified).toISOString(),
						bytes: size,
					};
				})
				.filter((pdf) => PDF_ID.test(pdf.id))
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			return c.json({ pdfs } satisfies ReportPdfs);
		})
		.get("/report-pdfs/:pdfId", async (c) => {
			const bucket = needStorage(storage);
			const id = c.req.param("pdfId");
			const key = `${pdfPrefix(c)}${id}.pdf`;
			// Another person's PDF, or another family's, reads exactly like a missing one.
			if (!(PDF_ID.test(id) && (await bucket.exists(key))))
				throw new ApiFailure("not_found", "No such PDF");
			const seconds = 300;
			const url = await bucket.presign(
				key,
				`lab-report-${id.slice(0, 8)}.pdf`,
				seconds,
			);
			const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
			return c.json({ url, expiresAt } satisfies ReportPdfLink);
		});
