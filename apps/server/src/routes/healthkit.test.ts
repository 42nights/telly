// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). Every sample
// is a synthetic fixture: it proves the mapping, not a real HealthKit read (`docs/healthkit.md`).
import { describe, expect, test } from "bun:test";
import {
	HealthKitImportResult,
	type HealthKitSample,
} from "@health/contracts/healthkit";
import { Effect, Schema } from "effect";
import { readFamilyRecords } from "../db";
import { healthKitRoutes } from "./healthkit";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const watchHeartRate: HealthKitSample = {
	uuid: "00000000-0000-4000-8000-000000000001",
	type: "HKQuantityTypeIdentifierHeartRate",
	value: 72,
	unit: "count/min",
	startDate: ago(5 * 60_000),
	endDate: ago(5 * 60_000),
	sourceBundleId: "com.apple.health.SYNTHETIC",
	sourceName: "Synthetic Watch",
	deviceModel: "Watch7,1",
	deviceManufacturer: "Apple Inc.",
	externalUuid: null,
};
const oldOxygen: HealthKitSample = {
	...watchHeartRate,
	uuid: "00000000-0000-4000-8000-000000000002",
	type: "HKQuantityTypeIdentifierOxygenSaturation",
	value: 0.97,
	unit: "%",
	startDate: ago(3 * 86_400_000),
	endDate: ago(3 * 86_400_000),
};
// WHOOP data that also reached Health: NOOP's write-back and heart-rate stream, and the WHOOP app.
const whoop: HealthKitSample[] = [
	{
		...watchHeartRate,
		uuid: "00000000-0000-4000-8000-000000000003",
		type: "HKQuantityTypeIdentifierRestingHeartRate",
		value: 55,
		sourceBundleId: "com.example.synthetic",
		sourceName: "Synthetic",
		deviceModel: null,
		externalUuid: "noop:HKQuantityTypeIdentifierRestingHeartRate:2026-10-03",
	},
	{
		...watchHeartRate,
		uuid: "00000000-0000-4000-8000-000000000004",
		sourceBundleId: "com.noopapp.noop.staging",
		sourceName: "NOOP",
		deviceModel: null,
	},
	{
		...watchHeartRate,
		uuid: "00000000-0000-4000-8000-000000000005",
		type: "HKQuantityTypeIdentifierRestingHeartRate",
		value: 54,
		sourceBundleId: "com.whoop.iphone",
		sourceName: "WHOOP",
		deviceModel: null,
	},
];

const decode = Schema.decodeUnknownSync(HealthKitImportResult);

describe.skipIf(dbConfig === undefined)("HealthKit import", () => {
	test("keeps provenance, skips WHOOP-origin samples, and records a resent sample once", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "healthkit-import");
				const app = familyApp(db, familyId, healthKitRoutes());
				const body = {
					access: "requested",
					synthetic: true,
					samples: [watchHeartRate, ...whoop, oldOxygen, watchHeartRate],
				};

				const first = yield* send(app, "POST", "/healthkit/samples", body);
				expect(first.status).toBe(200);
				const result = decode(first.json);
				expect(result.samples.map((s) => s.outcome)).toEqual([
					"recorded",
					"whoop_origin",
					"whoop_origin",
					"whoop_origin",
					"recorded",
					"duplicate",
				]);
				// WHOOP resting heart rate was skipped, so HealthKit has none: no_sample, not 54 or 55.
				expect(
					Object.fromEntries(result.metrics.map((m) => [m.metric, m.state])),
				).toEqual({
					heart_rate: "fresh",
					resting_heart_rate: "no_sample",
					hrv_sdnn: "no_sample",
					respiratory_rate: "no_sample",
					oxygen_saturation: "stale",
				});

				const stored = readFamilyRecords(db).samples.filter(
					(row) => row.familyId === familyId,
				);
				expect(
					stored.map(({ metric, value, unit, source, synthetic, quality }) => ({
						metric,
						value,
						unit,
						source,
						synthetic,
						quality,
					})),
				).toEqual([
					{
						metric: "heart_rate",
						value: 72,
						unit: "bpm",
						source: "healthkit:com.apple.health.SYNTHETIC:Watch7,1",
						synthetic: true,
						quality: "unvalidated",
					},
					{
						metric: "oxygen_saturation",
						value: 97,
						unit: "%",
						source: "healthkit:com.apple.health.SYNTHETIC:Watch7,1",
						synthetic: true,
						quality: "unvalidated",
					},
				]);
				const [heartId = "", oxygenId = ""] = stored.map((row) => row.id);
				expect(result.samples.map((s) => s.sampleId)).toEqual([
					heartId,
					null,
					null,
					null,
					oxygenId,
					heartId,
				]);

				const resent = decode(
					(yield* send(app, "POST", "/healthkit/samples", body)).json,
				);
				expect(resent.samples.map((s) => [s.outcome, s.sampleId])).toEqual(
					result.samples.map((s) => [
						s.outcome === "recorded" ? "duplicate" : s.outcome,
						s.sampleId,
					]),
				);
				expect(
					readFamilyRecords(db).samples.filter(
						(row) => row.familyId === familyId,
					),
				).toHaveLength(2);
			}),
		));

	test("denied and absent HealthKit report no value; contradictory or mis-unit batches record nothing", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "healthkit-denied");
				const app = familyApp(db, familyId, healthKitRoutes());
				for (const access of ["denied", "unavailable"] as const) {
					const reply = yield* send(app, "POST", "/healthkit/samples", {
						access,
						synthetic: true,
						samples: [],
					});
					const result = decode(reply.json);
					expect(result.metrics.map((m) => [m.state, m.sample])).toEqual(
						Array(5).fill([access, null]),
					);
				}
				expect(
					failure(
						yield* send(app, "POST", "/healthkit/samples", {
							access: "denied",
							synthetic: true,
							samples: [watchHeartRate],
						}),
					),
				).toEqual([400, "invalid_request"]);
				expect(
					failure(
						yield* send(app, "POST", "/healthkit/samples", {
							access: "requested",
							synthetic: true,
							samples: [oldOxygen, { ...watchHeartRate, unit: "count/s" }],
						}),
					),
				).toEqual([400, "invalid_request"]);
				expect(
					readFamilyRecords(db).samples.filter(
						(row) => row.familyId === familyId,
					),
				).toEqual([]);
			}),
		));
});
