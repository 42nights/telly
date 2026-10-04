// HealthKit import route (issue #47), mounted at `/api/families/:familyId`. Samples go through the
// same `recordSample` reducer as every other source, so membership is checked again there.
import {
	HealthKitImport,
	type HealthKitImportResult,
	healthKitTypes,
} from "@health/contracts/healthkit";
import { Hono } from "hono";
import { Timestamp } from "spacetimedb";
import { readFamilyRecords } from "../db";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import {
	healthKitMetrics,
	isWhoopOrigin,
	readingKey,
	toNewHealthSample,
} from "../integrations/healthkit";

export const healthKitRoutes = () =>
	new Hono<FamilyEnv>().post("/healthkit/samples", async (c) => {
		const { db, familyId } = c.var;
		const body = await decodeBody(c, HealthKitImport);
		if (body.access !== "requested" && body.samples.length > 0)
			throw new ApiFailure(
				"invalid_request",
				"Samples need HealthKit access: requested",
			);
		const id = familyId.toString();
		// Check every unit before the first write, so a bad batch records nothing.
		const entries = body.samples.map((sample) => {
			if (isWhoopOrigin(sample)) return { uuid: sample.uuid, row: null };
			const row = toNewHealthSample(sample, body.synthetic);
			if (row === null)
				throw new ApiFailure(
					"invalid_request",
					`${sample.type} must be read in ${healthKitTypes[sample.type].hkUnit}`,
				);
			return { uuid: sample.uuid, row };
		});
		const seen = new Set(
			readFamilyRecords(db)
				.samples.filter((row) => row.familyId === id)
				.map((row) => readingKey(row, row.sourceTime)),
		);
		// ponytail: the reading key (source, metric, unit, value, time) stands in for the HealthKit
		// UUID, which the sample table has no column for. Two concurrent imports of one sample can
		// both record it; add a unique source-sample id to the table if HealthKit goes live.
		const outcomes = [];
		for (const { uuid, row } of entries) {
			if (row === null) {
				outcomes.push({ uuid, outcome: "whoop_origin" as const, key: null });
				continue;
			}
			const key = readingKey(row, row.sourceTime);
			if (seen.has(key)) {
				outcomes.push({ uuid, outcome: "duplicate" as const, key });
				continue;
			}
			await callReducer(db, (connection) =>
				connection.reducers.recordSample({
					...row,
					familyId,
					sourceTime: Timestamp.fromDate(new Date(row.sourceTime)),
					quality: { tag: "Unvalidated" },
				}),
			);
			seen.add(key);
			outcomes.push({ uuid, outcome: "recorded" as const, key });
		}
		const stored = readFamilyRecords(db).samples.filter(
			(row) => row.familyId === id,
		);
		const idOf = new Map(
			stored.map((row) => [readingKey(row, row.sourceTime), row.id]),
		);
		return c.json({
			samples: outcomes.map(({ uuid, outcome, key }) => ({
				uuid,
				outcome,
				sampleId: key === null ? null : (idOf.get(key) ?? null),
			})),
			metrics: healthKitMetrics(body.access, stored, new Date()),
		} satisfies HealthKitImportResult);
	});
