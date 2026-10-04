// A health reading in everyday words, for every screen that shows one: its name, its value with a
// human unit, and where it came from.
import type { HealthSample } from "@health/contracts";

/** Metrics whose everyday name differs from their id. */
const metricNames: Record<string, string> = {
	hrv: "HRV",
	spo2: "SpO2",
	daily_steps: "Steps",
	daily_strain: "Strain",
	sleep_duration: "Sleep",
	respiratory_rate: "Breathing",
};

/** `heart_rate` → `Heart rate`, `hrv` → `HRV`. */
export const metricLabel = (metric: string) => {
	const named = metricNames[metric];
	if (named !== undefined) return named;
	const text = metric.replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * A reading's value in everyday units: "Yes" for a boolean, "8 h 57 m" for an hour or more of
 * minutes, and strain on WHOOP's 0–21 scale (stored 0–100, see data/whoop/README.md).
 */
export const readingValue = ({
	metric,
	value,
	unit,
}: Pick<HealthSample, "metric" | "value" | "unit">): string => {
	if (unit === "boolean") return value === 0 ? "No" : "Yes";
	if (metric === "daily_strain") return (value * 0.21).toFixed(1);
	if (unit === "min" && Math.round(value) >= 60) {
		const minutes = Math.round(value);
		return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
	}
	if (unit === "steps") return value.toLocaleString();
	if (unit === "breaths/min") return `${value} /min`;
	return `${value} ${unit}`;
};

/** Where a reading came from, in words: a `noop:` source is the WHOOP band. */
export const sourceName = (source: string) =>
	source.startsWith("noop:") ? "WHOOP" : source;
