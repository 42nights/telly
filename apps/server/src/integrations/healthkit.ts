// Maps HealthKit samples onto health samples (issue #47, `docs/healthkit.md`). Pure: the route
// records the result.
import type { HealthSample } from "@health/contracts";
import type { NewHealthSample } from "@health/contracts/families";
import {
	type HealthKitAccess,
	type HealthKitMetric,
	type HealthKitSample,
	healthKitTypes,
} from "@health/contracts/healthkit";
import { STALE_AFTER_MS } from "../family-tools";

const SOURCE_PREFIX = "healthkit:";

/**
 * WHOOP data reaches Health two ways: NOOP's write-back (an external UUID `noop:…`, or the NOOP
 * app as source for its heart-rate stream) and the WHOOP app. NOOP is the only WHOOP path here, so
 * these samples would count the same strap twice.
 */
export const isWhoopOrigin = (sample: HealthKitSample) =>
	sample.externalUuid?.startsWith("noop:") === true ||
	/(^|\.)(noop|noopapp|whoop)(\.|$)/i.test(sample.sourceBundleId) ||
	/whoop/i.test(sample.deviceManufacturer ?? "");

/**
 * The stored form, or null when `unit` is not the type's HealthKit unit. Never validated. The
 * source is the writing app and, when there is one, the device model: `healthkit:<bundle>[:<model>]`.
 */
export const toNewHealthSample = (
	sample: HealthKitSample,
	synthetic: boolean,
): NewHealthSample | null => {
	const type = healthKitTypes[sample.type];
	if (sample.unit !== type.hkUnit) return null;
	return {
		metric: type.metric,
		value: sample.value * type.scale,
		unit: type.unit,
		sourceTime: sample.startDate,
		source: `${SOURCE_PREFIX}${sample.sourceBundleId}${sample.deviceModel === null ? "" : `:${sample.deviceModel}`}`,
		synthetic,
		quality: "unvalidated",
	};
};

/** One stored reading, whatever the time's precision: the same reading gets the same key. */
export const readingKey = (
	sample: Pick<HealthSample, "metric" | "value" | "unit" | "source">,
	sourceTime: string,
) =>
	`${sample.source}|${sample.metric}|${sample.unit}|${sample.value}|${Date.parse(sourceTime)}`;

/** Every HealthKit metric's state, from the newest stored HealthKit sample of it. */
export const healthKitMetrics = (
	access: HealthKitAccess,
	samples: readonly HealthSample[],
	now: Date,
): HealthKitMetric[] =>
	Object.values(healthKitTypes).map(({ metric, unit }) => {
		const newest = samples
			.filter(
				(row) =>
					row.metric === metric &&
					row.unit === unit &&
					row.source.startsWith(SOURCE_PREFIX),
			)
			.reduce<HealthSample | null>(
				(best, row) =>
					best === null ||
					Date.parse(row.sourceTime) > Date.parse(best.sourceTime)
						? row
						: best,
				null,
			);
		const state =
			access !== "requested"
				? access
				: newest === null
					? "no_sample"
					: now.getTime() - Date.parse(newest.sourceTime) > STALE_AFTER_MS
						? "stale"
						: "fresh";
		return { metric, state, sample: newest };
	});
