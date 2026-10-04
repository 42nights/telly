import { expect, test } from "bun:test";
import { afterQuietHours, nextLocalTime } from "./local-time";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

test("a daily time keeps its wall-clock time across both daylight-saving changes", () => {
	// 08:00 New York is 13:00Z in winter and 12:00Z in summer.
	expect(iso(nextLocalTime(at("2026-03-07T14:00:00Z"), 8 * 60, NY))).toBe(
		"2026-03-08T12:00:00.000Z",
	);
	expect(iso(nextLocalTime(at("2026-10-31T13:00:00Z"), 8 * 60, NY))).toBe(
		"2026-11-01T13:00:00.000Z",
	);
});

test("a skipped local time moves forward by the gap, and a repeated one takes its first instant", () => {
	// 02:30 does not exist on 2026-03-08; 03:30 EDT is 07:30Z.
	expect(iso(nextLocalTime(at("2026-03-08T05:00:00Z"), 2 * 60 + 30, NY))).toBe(
		"2026-03-08T07:30:00.000Z",
	);
	// 01:30 happens twice on 2026-11-01: 05:30Z (EDT) first, then 06:30Z (EST).
	expect(iso(nextLocalTime(at("2026-11-01T04:00:00Z"), 1 * 60 + 30, NY))).toBe(
		"2026-11-01T05:30:00.000Z",
	);
});

test("the next time is strictly later, so a due time moves to the next day", () => {
	expect(iso(nextLocalTime(at("2026-06-01T12:00:00Z"), 8 * 60, NY))).toBe(
		"2026-06-02T12:00:00.000Z",
	);
});

test("quiet hours across midnight hold a prompt until they end, in local time", () => {
	const quiet = { start: 22 * 60, end: 7 * 60 };
	// 23:30 EDT on 2026-10-31 waits for 07:00 EST on 2026-11-01 (12:00Z), across the clock change.
	expect(iso(afterQuietHours(at("2026-11-01T03:30:00Z"), quiet, NY))).toBe(
		"2026-11-01T12:00:00.000Z",
	);
	// 06:00 waits for 07:00 the same morning; 12:00 is outside and stays.
	expect(iso(afterQuietHours(at("2026-06-01T10:00:00Z"), quiet, NY))).toBe(
		"2026-06-01T11:00:00.000Z",
	);
	expect(afterQuietHours(at("2026-06-01T16:00:00Z"), quiet, NY)).toBe(
		at("2026-06-01T16:00:00Z"),
	);
	expect(afterQuietHours(at("2026-06-01T03:00:00Z"), undefined, NY)).toBe(
		at("2026-06-01T03:00:00Z"),
	);
});
