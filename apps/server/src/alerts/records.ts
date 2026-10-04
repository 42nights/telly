import { drivesMonitoring, type HealthSample } from "@health/contracts";
import type {
	AlertThreshold,
	FamilyAlert,
	Monitoring,
} from "@health/contracts/alerts";
import { type FamilyDb, readFamilyRecords } from "../db";

const direction = { Above: "above", Below: "below" } as const;
const delivery = {
	Queued: "queued",
	Sent: "sent",
	Failed: "failed",
	Unavailable: "unavailable",
} as const;

/** The family's alert rules, as the caller's database identity sees them. */
export const readThresholds = (
	{ connection }: FamilyDb,
	familyId: string,
): AlertThreshold[] =>
	[...connection.db.myAlertThresholds.iter()]
		.filter((row) => row.familyId.toString() === familyId)
		.map((row) => ({
			id: row.id.toString(),
			familyId,
			metric: row.metric,
			direction: direction[row.direction.tag],
			limit: row.limit,
			unit: row.unit,
			maxAgeSeconds: row.maxAgeSeconds,
			updatedBy: row.updatedBy.toHexString(),
			updatedAt: row.updatedAt.toISOString(),
		}));

/** The family's alerts, newest first, each with its source sample, delivery, and acknowledgements. */
export const readAlerts = (db: FamilyDb, familyId: string): FamilyAlert[] => {
	const records = readFamilyRecords(db);
	const samples = new Map(records.samples.map((s) => [s.id, s]));
	const deliveries = new Map(
		[...db.connection.db.myAlertDeliveries.iter()].map((row) => [
			row.alertId.toString(),
			{
				alertId: row.alertId.toString(),
				status: delivery[row.status.tag],
				attempts: row.attempts,
				lastError: row.lastError ?? null,
				updatedAt: row.updatedAt.toISOString(),
			},
		]),
	);
	return records.alerts
		.filter((alert) => alert.familyId === familyId)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map((alert) => ({
			alert,
			sample:
				alert.sampleId === null ? null : (samples.get(alert.sampleId) ?? null),
			delivery: deliveries.get(alert.id) ?? null,
			acknowledgements: records.acknowledgements.filter(
				(ack) => ack.alertId === alert.id,
			),
		}));
};

// The database applies the same rule when it raises an alert: a source clock may run up to a
// minute ahead; further ahead, the sample is not fresh.
const MAX_CLOCK_AHEAD_MS = 60_000;

/**
 * Each threshold's state from its newest sample that drives monitoring (`drivesMonitoring`) in the threshold's unit. A missing or stale
 * sample makes the threshold `unavailable`; nothing here reports in range without fresh data.
 */
export const monitor = (
	thresholds: readonly AlertThreshold[],
	samples: readonly HealthSample[],
	now: Date,
): Monitoring => ({
	checkedAt: now.toISOString(),
	thresholds: thresholds.map((threshold) => {
		const sample = samples
			.filter(
				(s) =>
					s.familyId === threshold.familyId &&
					s.metric === threshold.metric &&
					s.unit === threshold.unit &&
					drivesMonitoring(s),
			)
			.reduce<HealthSample | null>(
				(newest, s) =>
					newest === null || s.sourceTime > newest.sourceTime ? s : newest,
				null,
			);
		if (sample === null)
			return { threshold, state: "unavailable", reason: "missing", sample };
		const age = now.getTime() - Date.parse(sample.sourceTime);
		if (age > threshold.maxAgeSeconds * 1000 || age < -MAX_CLOCK_AHEAD_MS)
			return { threshold, state: "unavailable", reason: "stale", sample };
		const beyond =
			threshold.direction === "above"
				? sample.value > threshold.limit
				: sample.value < threshold.limit;
		return {
			threshold,
			state: beyond ? "out_of_range" : "in_range",
			reason: null,
			sample,
		};
	}),
});
