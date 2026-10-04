import { Schema } from "effect";
import { Alert, AlertAcknowledgement, HealthSample } from "./index";

// Threshold alerts and their delivery (issue #5). Ids, identities, and times use the same string
// forms as the family records in `./index`.

export const ThresholdDirection = Schema.Literals(["above", "below"]);
export type ThresholdDirection = typeof ThresholdDirection.Type;

/**
 * `PUT /api/families/:familyId/alert-thresholds`: one rule per metric and direction; setting it again
 * replaces it. A validated sample in `unit` that is strictly beyond `limit` raises an alert, unless it
 * is stale: older than `maxAgeSeconds` when it arrives.
 */
export const AlertThresholdInput = Schema.Struct({
	metric: Schema.NonEmptyString,
	direction: ThresholdDirection,
	limit: Schema.Finite,
	unit: Schema.NonEmptyString,
	maxAgeSeconds: Schema.Int.check(
		Schema.isBetween({ minimum: 1, maximum: 7 * 24 * 60 * 60 }),
	),
});
export type AlertThresholdInput = typeof AlertThresholdInput.Type;

export const AlertThreshold = Schema.Struct({
	id: Schema.String,
	familyId: Schema.String,
	...AlertThresholdInput.fields,
	updatedBy: Schema.String,
	updatedAt: Schema.String,
});
export type AlertThreshold = typeof AlertThreshold.Type;

/** `GET /api/families/:familyId/alert-thresholds`. */
export const AlertThresholds = Schema.Struct({
	thresholds: Schema.Array(AlertThreshold),
});
export type AlertThresholds = typeof AlertThresholds.Type;

/**
 * Provider delivery to the family, separate from acknowledgement. `unavailable` means no delivery
 * transport is configured; the alert is not sent, and it is sent once a transport is configured.
 */
export const DeliveryStatus = Schema.Literals([
	"queued",
	"sent",
	"failed",
	"unavailable",
]);
export type DeliveryStatus = typeof DeliveryStatus.Type;

export const AlertDelivery = Schema.Struct({
	alertId: Schema.String,
	status: DeliveryStatus,
	attempts: Schema.Int,
	lastError: Schema.NullOr(Schema.String),
	updatedAt: Schema.String,
});
export type AlertDelivery = typeof AlertDelivery.Type;

/** An alert with the sample that raised it (null for a manual alert), its delivery, and who saw it. */
export const FamilyAlert = Schema.Struct({
	alert: Alert,
	sample: Schema.NullOr(HealthSample),
	delivery: Schema.NullOr(AlertDelivery),
	acknowledgements: Schema.Array(AlertAcknowledgement),
});
export type FamilyAlert = typeof FamilyAlert.Type;

/** `GET /api/families/:familyId/alerts`, newest first. */
export const FamilyAlerts = Schema.Struct({
	alerts: Schema.Array(FamilyAlert),
});
export type FamilyAlerts = typeof FamilyAlerts.Type;

/** `POST /api/families/:familyId/alerts/:alertId/acknowledgements`: the caller's acknowledgement. */
export const AcknowledgedAlert = Schema.Struct({
	acknowledgement: AlertAcknowledgement,
});
export type AcknowledgedAlert = typeof AcknowledgedAlert.Type;

/**
 * One threshold's current state, from the newest validated sample in its unit. Without a fresh one
 * the state is `unavailable` (`missing` or `stale`), never in range.
 */
export const ThresholdMonitoring = Schema.Struct({
	threshold: AlertThreshold,
	state: Schema.Literals(["in_range", "out_of_range", "unavailable"]),
	reason: Schema.NullOr(Schema.Literals(["missing", "stale"])),
	sample: Schema.NullOr(HealthSample),
});
export type ThresholdMonitoring = typeof ThresholdMonitoring.Type;

/** `GET /api/families/:familyId/monitoring`. No thresholds means nothing is monitored. */
export const Monitoring = Schema.Struct({
	checkedAt: Schema.String,
	thresholds: Schema.Array(ThresholdMonitoring),
});
export type Monitoring = typeof Monitoring.Type;
