import { describe, expect, test } from "bun:test";
import { NewCareNeed } from "@health/contracts/care";
import {
	describeLocation,
	type SharedLocation,
} from "@health/contracts/location";
import { Schema } from "effect";

import {
	directionsUrl,
	errorReport,
	fixReport,
	helpMessage,
	mapUrl,
	tripStatus,
} from "./logic";

const now = Date.parse("2026-01-01T08:00:00Z");
const at = (minutesAgo: number) =>
	new Date(now - minutesAgo * 60_000).toISOString();
const fix = (minutesAgo: number, accuracyMeters = 10) => ({
	latitude: 1,
	longitude: 2,
	accuracyMeters,
	fixTime: at(minutesAgo),
});
const location = (over: Partial<SharedLocation>): SharedLocation => ({
	familyId: "1",
	sharer: "a".repeat(64),
	status: "fix",
	fix: fix(0),
	reportedAt: at(0),
	...over,
});
const kind = (over: Partial<SharedLocation>) =>
	describeLocation(location(over), now).kind;

describe("describeLocation", () => {
	test("labels a fresh, exact fix current and a wide one approximate", () => {
		expect(kind({})).toBe("current");
		expect(kind({ fix: fix(0, 100) })).toBe("current");
		expect(kind({ fix: fix(0, 101) })).toBe("approximate");
	});

	test("an old fix is last known, even when the report is new", () => {
		expect(kind({ fix: fix(10) })).toBe("current");
		expect(kind({ fix: fix(11) })).toBe("last_known");
	});

	test("GPS denied and no signal keep the last fix but never read as current", () => {
		const denied = describeLocation(location({ status: "gps_denied" }), now);
		expect(denied).toMatchObject({ kind: "gps_denied", fix: fix(0) });
		expect(kind({ status: "gps_denied", fix: null })).toBe("gps_denied");
		expect(kind({ status: "no_fix" })).toBe("no_signal");
		expect(kind({ status: "no_fix", fix: null })).toBe("no_position");
	});

	test("a silent phone wins over every other state", () => {
		expect(kind({ reportedAt: at(30) })).toBe("current");
		const silent = describeLocation(
			location({ reportedAt: at(31), status: "gps_denied" }),
			now,
		);
		expect(silent.kind).toBe("phone_silent");
		expect(silent.text).toContain("31 min");
		expect(silent.text).toContain("not carried");
	});

	test("no label claims the person is safe", () => {
		for (const over of [
			{},
			{ status: "no_fix" as const },
			{ reportedAt: at(90) },
		])
			expect(describeLocation(location(over), now).text).not.toMatch(/safe/i);
	});
});

describe("trip status", () => {
	const out = (minutesAgo: number, distanceMeters: number | null) =>
		tripStatus(
			{
				home: { latitude: 1, longitude: 2 },
				radiusMeters: 200,
				autoTrip: true,
				awaySince: at(minutesAgo),
				distanceMeters,
				sharing: true,
			},
			now,
		);

	test("rounds the distance to 10 m under a kilometer, and leaves it out when unknown", () => {
		expect(out(10, 1234)).toBe("1.2 km from home · left 10 min ago");
		expect(out(0, 347)).toBe("350 m from home · left just now");
		expect(out(5, null)).toBe("left 5 min ago");
	});

	test("the help message carries no coordinates and fits a care need summary", () => {
		const summary = helpMessage(at(30), true);
		expect(summary).not.toMatch(/\d+\.\d+/);
		expect(helpMessage(null, false)).toContain("I have not shared my location");
		const need = {
			clientId: "a",
			kind: "help",
			summary,
			sampleIds: [],
			dueAt: null,
		};
		expect(Schema.decodeUnknownSync(NewCareNeed)(need).summary).toBe(summary);
	});
});

describe("maps links", () => {
	test("directions ask the maps app for a walking route to a typed place or a saved position", () => {
		const url = new URL(directionsUrl("Café & Co, 5th Ave"));
		expect(url.origin).toBe("https://www.google.com");
		expect(url.searchParams.get("travelmode")).toBe("walking");
		expect(url.searchParams.get("destination")).toBe("Café & Co, 5th Ave");
		expect(
			new URL(
				directionsUrl({ latitude: 40.5, longitude: -73.25 }),
			).searchParams.get("destination"),
		).toBe("40.5,-73.25");
	});

	test("a shared fix opens a marker at its coordinates", () => {
		expect(mapUrl(fix(0))).toBe(
			"https://www.openstreetmap.org/?mlat=1&mlon=2#map=17/1/2",
		);
	});
});

describe("device reports", () => {
	const position = (accuracy: number) => ({
		coords: { latitude: 51.5, longitude: -0.12, accuracy },
		timestamp: now,
	});

	test("a position becomes a fix with whole meters and the device time", () => {
		expect(fixReport(position(12.6) as GeolocationPosition)).toEqual({
			status: "fix",
			fix: {
				latitude: 51.5,
				longitude: -0.12,
				accuracyMeters: 13,
				fixTime: "2026-01-01T08:00:00.000Z",
			},
		});
	});

	test("an accuracy under one meter still reports one meter, which the contract accepts", () => {
		const report = fixReport(position(0.2) as GeolocationPosition);
		expect(report.status === "fix" && report.fix.accuracyMeters).toBe(1);
	});

	test("a denied permission is its own state; a timeout or no signal is no fix", () => {
		const error = (code: number) =>
			({
				code,
				PERMISSION_DENIED: 1,
				POSITION_UNAVAILABLE: 2,
				TIMEOUT: 3,
			}) as GeolocationPositionError;
		expect(errorReport(error(1))).toEqual({ status: "gps_denied" });
		expect(errorReport(error(2))).toEqual({ status: "no_fix" });
		expect(errorReport(error(3))).toEqual({ status: "no_fix" });
	});
});
