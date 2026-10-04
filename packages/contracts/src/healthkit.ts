import { Schema } from "effect";
import { UtcTime } from "./families";
import { HealthSample } from "./index";

// Conditional HealthKit import (issue #47; inventory and limits in `docs/healthkit.md`). An iPhone
// reads HealthKit quantity samples and sends them as read; the server stores them as `HealthSample`
// rows. WHOOP data never enters through HealthKit: it has its own NOOP path.

export const HealthKitType = Schema.Literals([
	"HKQuantityTypeIdentifierHeartRate",
	"HKQuantityTypeIdentifierRestingHeartRate",
	"HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
	"HKQuantityTypeIdentifierRespiratoryRate",
	"HKQuantityTypeIdentifierOxygenSaturation",
]);
export type HealthKitType = typeof HealthKitType.Type;

/**
 * Each accepted type: the `HKUnit` string the phone reads it in, and the metric and unit it is
 * stored as, after multiplying by `scale`.
 */
export const healthKitTypes = {
	HKQuantityTypeIdentifierHeartRate: {
		hkUnit: "count/min",
		metric: "heart_rate",
		unit: "bpm",
		scale: 1,
	},
	HKQuantityTypeIdentifierRestingHeartRate: {
		hkUnit: "count/min",
		metric: "resting_heart_rate",
		unit: "bpm",
		scale: 1,
	},
	// SDNN. NOOP stores RMSSD as `hrv`; the two measures differ, so they stay separate metrics.
	HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
		hkUnit: "ms",
		metric: "hrv_sdnn",
		unit: "ms",
		scale: 1,
	},
	HKQuantityTypeIdentifierRespiratoryRate: {
		hkUnit: "count/min",
		metric: "respiratory_rate",
		unit: "breaths/min",
		scale: 1,
	},
	// HealthKit reads a percentage as a fraction: 0.97 in `%` is 97 %.
	HKQuantityTypeIdentifierOxygenSaturation: {
		hkUnit: "%",
		metric: "oxygen_saturation",
		unit: "%",
		scale: 100,
	},
} as const satisfies Record<
	HealthKitType,
	{ hkUnit: string; metric: string; unit: string; scale: number }
>;

/** One `HKQuantitySample` as the phone read it. The device name is not sent: people name devices. */
export const HealthKitSample = Schema.Struct({
	/** `HKObject.uuid`: the sample's identity in the phone's Health store. */
	uuid: Schema.String.check(
		Schema.isPattern(
			/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
		),
	),
	type: HealthKitType,
	/** `quantity.doubleValue(for:)` in `unit`, which must be the type's `hkUnit`. */
	value: Schema.Finite,
	unit: Schema.NonEmptyString,
	startDate: UtcTime,
	endDate: UtcTime,
	/** `sourceRevision.source`: the app that wrote the sample, such as `com.apple.health.<id>`. */
	sourceBundleId: Schema.NonEmptyString,
	sourceName: Schema.NonEmptyString,
	/** `device.model` and `device.manufacturer`, when the writer set them. */
	deviceModel: Schema.NullOr(Schema.NonEmptyString),
	deviceManufacturer: Schema.NullOr(Schema.NonEmptyString),
	/** `HKMetadataKeyExternalUUID`. NOOP's Health write-back sets `noop:<kind>:<identity>`. */
	externalUuid: Schema.NullOr(Schema.String),
});
export type HealthKitSample = typeof HealthKitSample.Type;

/**
 * What the phone knows about HealthKit read access. `unavailable`: no HealthKit on this device or
 * build. `denied`: the request failed or Health data is restricted. `requested`: the permission
 * sheet was answered. iOS hides a denied read type from the app (it reads as empty), so after
 * `requested` an empty read is `no_sample`, never a zero.
 */
export const HealthKitAccess = Schema.Literals([
	"unavailable",
	"denied",
	"requested",
]);
export type HealthKitAccess = typeof HealthKitAccess.Type;

/** `POST /api/families/:familyId/healthkit/samples`. Samples need `access: requested`. */
export const HealthKitImport = Schema.Struct({
	access: HealthKitAccess,
	/** True for demo fixtures, never for a real read. Every recorded sample keeps it. */
	synthetic: Schema.Boolean,
	samples: Schema.Array(HealthKitSample).check(Schema.isMaxLength(500)),
});
export type HealthKitImport = typeof HealthKitImport.Type;

/**
 * Per sample: `recorded` (a new row), `duplicate` (the same reading is already stored; `sampleId` is
 * that row), or `whoop_origin` (WHOOP data, which only the NOOP path records; `sampleId` is null).
 */
export const HealthKitSampleOutcome = Schema.Struct({
	uuid: Schema.String,
	outcome: Schema.Literals(["recorded", "duplicate", "whoop_origin"]),
	sampleId: Schema.NullOr(Schema.String),
});
export type HealthKitSampleOutcome = typeof HealthKitSampleOutcome.Type;

/**
 * One metric after the import, from the newest stored HealthKit sample. `unavailable` and `denied`
 * repeat the access; `no_sample` and `stale` are unknown values, never zero or normal.
 */
export const HealthKitMetric = Schema.Struct({
	metric: Schema.NonEmptyString,
	state: Schema.Literals([
		"unavailable",
		"denied",
		"no_sample",
		"stale",
		"fresh",
	]),
	sample: Schema.NullOr(HealthSample),
});
export type HealthKitMetric = typeof HealthKitMetric.Type;

export const HealthKitImportResult = Schema.Struct({
	samples: Schema.Array(HealthKitSampleOutcome),
	metrics: Schema.Array(HealthKitMetric),
});
export type HealthKitImportResult = typeof HealthKitImportResult.Type;
