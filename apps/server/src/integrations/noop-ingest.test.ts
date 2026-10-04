import { expect, test } from "bun:test";
import { type NoopSample, unstoredSamples } from "./noop-ingest";

const minute = 1_790_000_040_000;
const hr = (value: number, seconds: number): NoopSample => ({
	metric: "heart_rate",
	value,
	unit: "bpm",
	time: minute + seconds * 1000,
	source: "noop:my-whoop",
});

test("a newer heart rate in a stored minute is stored; an older or repeated one is not", () => {
	const stored = [hr(61, 5)];
	expect(unstoredSamples(stored, [hr(64, 35)])).toEqual([hr(64, 35)]);
	expect(unstoredSamples(stored, [hr(61, 5), hr(58, 2)])).toEqual([]);
	expect(unstoredSamples([...stored, hr(64, 35)], [hr(64, 35)])).toEqual([]);
});

test("another metric is stored again only when its value changed", () => {
	const strain = { ...hr(20, 0), metric: "daily_strain", unit: "%" };
	expect(unstoredSamples([strain], [strain])).toEqual([]);
	expect(unstoredSamples([strain], [{ ...strain, value: 21 }])).toEqual([
		{ ...strain, value: 21 },
	]);
});
