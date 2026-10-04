// Pure state mapping for the family phone and the dashboard. No fetches, no React.
import type { AlertAcknowledgement, HealthSample } from "@health/contracts";
import type {
	AlertDelivery,
	AlertThreshold,
	FamilyAlert,
	Monitoring,
} from "@health/contracts/alerts";

import { memberLabel } from "@/lib/members";

export type MonitoringLevel = "on" | "partial" | "stopped";

/** On only when every threshold has a fresh validated sample; no thresholds means nothing is monitored. */
export const monitoringLevel = (monitoring: Monitoring): MonitoringLevel => {
	const live = monitoring.thresholds.filter(
		(t) => t.state !== "unavailable",
	).length;
	if (live === 0) return "stopped";
	return live === monitoring.thresholds.length ? "on" : "partial";
};

/** A sample with no threshold to say otherwise is stale after a day. */
const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

/** `sample` is null when the metric has only demo samples: those are never a reading. */
export type Glance = {
	readonly metric: string;
	readonly sample: HealthSample | null;
	readonly stale: boolean;
};

/**
 * The newest real sample of each metric (by source time), with staleness from the metric's
 * threshold. Synthetic samples never count, as in `currentHeartRate`.
 */
export const newestPerMetric = (
	samples: readonly HealthSample[],
	thresholds: readonly AlertThreshold[],
	now: number,
): Glance[] => {
	const newest = new Map<string, HealthSample | null>();
	for (const sample of samples) {
		const seen = newest.get(sample.metric) ?? null;
		if (sample.synthetic) {
			if (!newest.has(sample.metric)) newest.set(sample.metric, null);
		} else if (
			seen === null ||
			Date.parse(sample.sourceTime) > Date.parse(seen.sourceTime)
		)
			newest.set(sample.metric, sample);
	}
	return [...newest]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([metric, sample]) => {
			if (sample === null) return { metric, sample, stale: false };
			const limits = thresholds
				.filter((t) => t.metric === metric)
				.map((t) => t.maxAgeSeconds);
			const maxAge =
				limits.length === 0 ? DEFAULT_MAX_AGE_SECONDS : Math.min(...limits);
			return {
				metric,
				sample,
				stale: now - Date.parse(sample.sourceTime) > maxAge * 1000,
			};
		});
};

/** One delivery status per alert, in plain words. */
export const deliveryText = (delivery: AlertDelivery | null): string => {
	if (delivery === null) return "No delivery record";
	const tries = `${delivery.attempts} ${delivery.attempts === 1 ? "try" : "tries"}`;
	switch (delivery.status) {
		case "sent":
			return "Sent";
		case "queued":
			return delivery.attempts === 0 ? "Queued" : `Queued, ${tries} so far`;
		case "failed":
			return `Failed after ${tries}`;
		case "unavailable":
			return "Not sent: no delivery transport";
	}
};

/** The newest alert nobody has seen yet; alerts arrive newest first. */
export const newestUnseen = (alerts: readonly FamilyAlert[]) =>
	alerts.find((a) => a.acknowledgements.length === 0) ?? null;

export const newestNoopSample = (
	samples: readonly HealthSample[],
	familyId: string,
): HealthSample | null =>
	samples
		.filter((s) => s.familyId === familyId && s.source.startsWith("noop:"))
		.reduce<HealthSample | null>(
			(newest, s) =>
				newest === null || s.sourceTime > newest.sourceTime ? s : newest,
			null,
		);

export const ago = (iso: string, now: number): string => {
	const minutes = Math.round((now - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
};

export const clock = (iso: string) =>
	new Date(iso).toLocaleString([], {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});

export const seenText = (
	acknowledgements: readonly AlertAcknowledgement[],
	me: string | null,
): string | null => {
	const first = acknowledgements[0];
	if (first === undefined) return null;
	const names = acknowledgements
		.map((a) => memberLabel(a.member, me))
		.join(", ");
	return `${names}, ${clock(first.acknowledgedAt)}`;
};

export const metricLabel = (metric: string) => {
	const text = metric.replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
};
