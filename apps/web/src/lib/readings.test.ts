import { expect, test } from "bun:test";

import { metricLabel, readingValue } from "./readings";

test("metricLabel turns a metric id into words", () => {
	expect(metricLabel("heart_rate")).toBe("Heart rate");
	expect(metricLabel("resting_heart_rate")).toBe("Resting heart rate");
	expect(metricLabel("hrv")).toBe("HRV");
	expect(metricLabel("daily_strain")).toBe("Strain");
	expect(metricLabel("")).toBe("");
});

test("readingValue writes WHOOP readings in everyday units", () => {
	const value = (metric: string, v: number, unit: string) =>
		readingValue({ metric, value: v, unit });
	expect(value("on_wrist", 1, "boolean")).toBe("Yes");
	expect(value("on_wrist", 0, "boolean")).toBe("No");
	// Stored 0–100; WHOOP's scale is 0–21 (data/whoop/README.md: 29.6 stored = 6.2).
	expect(value("daily_strain", 29.6, "noop effort (0-100)")).toBe("6.2");
	expect(value("daily_strain", 0, "noop effort (0-100)")).toBe("0.0");
	expect(value("sleep_duration", 536.6, "min")).toBe("8 h 57 m");
	expect(value("sleep_duration", 59.6, "min")).toBe("1 h 0 m");
	expect(value("sleep_duration", 45, "min")).toBe("45 min");
	expect(value("hrv", 104, "ms")).toBe("104 ms");
});
