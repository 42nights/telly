// Lab report routes (docs/board.html#wf-lab), mounted at `/api/families/:familyId`. The module's
// reducers check membership and the review lock again, so these handlers add no access rule.
import type { HealthSample } from "@health/contracts";
import {
	type Report,
	ReportFields,
	ReportMarker,
	type Reports,
} from "@health/contracts/reports";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { readFamilyRecords } from "../db";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";

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

const readReports = (c: Context<FamilyEnv>): Report[] =>
	[...c.var.db.connection.db.myReports.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.map((row) => ({
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
		}))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

const findReport = (c: Context<FamilyEnv>, id = c.req.param("reportId")) => {
	const report = readReports(c).find((row) => row.id === id);
	if (report === undefined)
		throw new ApiFailure("not_found", "No such report in this family");
	return report;
};

/** The report flow: generate a draft, fill it, review it, then submit it. */
export const reportRoutes = () =>
	new Hono<FamilyEnv>()
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
			const { id } = findReport(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.updateReport({
					id,
					fields: undefined,
					review: true,
				}),
			);
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
		});
