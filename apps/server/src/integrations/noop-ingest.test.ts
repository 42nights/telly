import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { Hono } from "hono";
import { Timestamp } from "spacetimedb";
import type { FamilyDb } from "../db";
import * as http from "../http";
import {
	type NoopSample,
	noopRoutes,
	recordNoopSamples,
	unstoredSamples,
} from "./noop-ingest";

// recordNoopSamples reaches the database only through callReducer; run its call on the fake.
const callReducer = spyOn(http, "callReducer").mockImplementation((db, call) =>
	call(db.connection),
);
afterAll(() => callReducer.mockRestore());

type Stored = {
	familyId: bigint;
	source: string;
	metric: string;
	value: number;
	sourceTime: Timestamp;
	receivedAt: Timestamp;
};
/** A connection with the `myHealthSamples` view and a `recordSample` reducer that keeps its arguments. */
const fakeDb = (stored: Stored[]) => {
	const recorded: Record<string, unknown>[] = [];
	const db = {
		connection: {
			db: { myHealthSamples: { iter: () => stored.values() } },
			reducers: {
				recordSample: async (args: Record<string, unknown>) => {
					recorded.push(args);
				},
			},
		},
	} as unknown as FamilyDb;
	return { db, recorded };
};
const at = (ms: number) => Timestamp.fromDate(new Date(ms));
const stored = (
	metric: string,
	value: number,
	time: number,
	receivedAt: number,
	familyId = 7n,
): Stored => ({
	familyId,
	source: "noop:d1",
	metric,
	value,
	sourceTime: at(time),
	receivedAt: at(receivedAt),
});
const sample = (metric: string, value: number, time: number): NoopSample => ({
	metric,
	value,
	unit: "u",
	time,
	source: "noop:d1",
});

describe("recordNoopSamples", () => {
	test("records new samples with the family, an Unvalidated quality, and not synthetic", async () => {
		const { db, recorded } = fakeDb([]);
		await recordNoopSamples(db, 7n)([sample("hrv", 41.5, 1_700_000_000_000)]);
		expect(recorded).toEqual([
			{
				familyId: 7n,
				metric: "hrv",
				value: 41.5,
				unit: "u",
				sourceTime: at(1_700_000_000_000),
				source: "noop:d1",
				synthetic: false,
				quality: { tag: "Unvalidated" },
			},
		]);
	});

	test("a newer heart rate in a stored minute replaces it; an older one is skipped", async () => {
		const minute = 1_700_000_040_000; // a whole minute
		const { db, recorded } = fakeDb([
			stored("heart_rate", 60, minute + 5_000, 1),
		]);
		await recordNoopSamples(
			db,
			7n,
		)([
			sample("heart_rate", 58, minute + 2_000), // older than the stored reading: skipped
			sample("heart_rate", 99, minute + 50_000), // newer, same minute as stored: kept
			sample("heart_rate", 70, minute + 60_000), // next minute: new
			sample("heart_rate", 71, minute + 61_000), // newer in that minute: kept
			sample("heart_rate", 70, minute + 60_000), // repeat of an older one: skipped
		]);
		expect(recorded.map((row) => row.value)).toEqual([99, 70, 71]);
	});

	test("records a daily value again only when it changed since the latest stored one", async () => {
		const day = Date.parse("2026-09-01T00:00:00Z");
		const { db, recorded } = fakeDb([
			// Received later, so 55 is the latest value; the 50 from another family does not count.
			stored("recovery", 55, day, 2),
			stored("recovery", 40, day, 1),
			stored("daily_steps", 50, day, 3, 8n),
		]);
		await recordNoopSamples(
			db,
			7n,
		)([
			sample("recovery", 55, day), // unchanged
			sample("recovery", 40, day), // changed back
			sample("daily_steps", 50, day), // new for this family
			sample("recovery", 40, day), // same as the one just recorded
		]);
		expect(recorded.map((row) => [row.metric, row.value])).toEqual([
			["recovery", 40],
			["daily_steps", 50],
		]);
	});
});

const deflated = (value: unknown) =>
	deflateRawSync(Buffer.from(JSON.stringify(value)));

const app = (key = "secret") => {
	const batches: NoopSample[][] = [];
	const routes = noopRoutes({
		identity: "0".repeat(64),
		legacy: { key, familyId: 7n },
		tokenFamily: () => undefined,
		record: async (_familyId, samples) => {
			batches.push([...samples]);
		},
	});
	const hono = new Hono()
		.post("/ingest", routes.ingest)
		.onError((error, c) =>
			c.text(error instanceof http.ApiFailure ? error.code : "crash", 500),
		);
	return { hono, batches, routes };
};
const post = (
	hono: Hono,
	body: Buffer,
	auth: { bearer?: string; query?: string } = { bearer: "secret" },
) =>
	hono.request(`/ingest${auth.query === undefined ? "" : `?k=${auth.query}`}`, {
		method: "POST",
		body,
		headers:
			auth.bearer === undefined
				? {}
				: { authorization: `Bearer ${auth.bearer}` },
	});

describe("noopRoutes ingest", () => {
	test("unconfigured is unavailable", async () => {
		const hono = new Hono()
			.post("/ingest", noopRoutes(undefined).ingest)
			.onError((error, c) =>
				c.text(error instanceof http.ApiFailure ? error.code : "crash", 500),
			);
		expect(await (await post(hono, deflated({ tables: {} }))).text()).toBe(
			"unavailable",
		);
	});

	test("a missing or wrong key is unauthorized and records nothing", async () => {
		const { hono, batches } = app();
		for (const auth of [{}, { bearer: "wrong" }, { query: "secre" }])
			expect(
				await (await post(hono, deflated({ tables: {} }), auth)).text(),
			).toBe("unauthorized");
		expect(batches).toEqual([]);
	});

	test("a body that is not a raw-deflate NOOP batch is invalid", async () => {
		const { hono, batches } = app();
		for (const body of [
			Buffer.from("plain text"),
			deflated({ nope: true }),
			deflated({ tables: { hrSample: [{ deviceId: "", ts: 1, bpm: 60 }] } }),
			deflated({
				tables: { dailyMetric: [{ deviceId: "x-noop", day: "bad" }] },
			}),
		])
			expect(await (await post(hono, body)).text()).toBe("invalid_request");
		expect(batches).toEqual([]);
	});

	test("decodes heart rate per minute, wrist events, and scaled daily values", async () => {
		const { hono, batches } = app();
		const response = await post(
			hono,
			deflated({
				tables: {
					hrSample: [
						{ deviceId: "d1", ts: 120, bpm: 60 },
						{ deviceId: "d1", ts: 150, bpm: 99 }, // same minute, newer: replaces 60
						{ deviceId: "d2", ts: 150, bpm: 70 }, // other device: kept
					],
					event: [
						{ deviceId: "d1", ts: 10, kind: "WRIST_ON" },
						{ deviceId: "d1", ts: 20, kind: "WRIST_OFF detected" },
						{ deviceId: "d1", ts: 30, kind: "WRIST_ONX" }, // not a word match
						{ deviceId: "d1", ts: 40, kind: "BATTERY_LOW" },
					],
					dailyMetric: [
						{
							deviceId: "w-noop",
							day: "2026-09-01",
							efficiency: 0.9234,
							steps: 8000,
							restingHr: null,
						},
						{ deviceId: "phone", day: "2026-09-01", steps: 1 }, // not a NOOP device
					],
				},
			}),
			{ query: "secret" },
		);
		expect(response.status).toBe(200);
		const day = Date.parse("2026-09-01T00:00:00Z");
		expect(batches).toEqual([
			[
				{
					metric: "heart_rate",
					value: 99,
					unit: "bpm",
					time: 150_000,
					source: "noop:d1",
				},
				{
					metric: "heart_rate",
					value: 70,
					unit: "bpm",
					time: 150_000,
					source: "noop:d2",
				},
				{
					metric: "on_wrist",
					value: 1,
					unit: "boolean",
					time: 10_000,
					source: "noop:d1",
				},
				{
					metric: "on_wrist",
					value: 0,
					unit: "boolean",
					time: 20_000,
					source: "noop:d1",
				},
				{
					metric: "sleep_efficiency",
					value: 92.3,
					unit: "%",
					time: day,
					source: "noop:w-noop",
				},
				{
					metric: "daily_steps",
					value: 8000,
					unit: "steps",
					time: day,
					source: "noop:w-noop",
				},
			],
		]);
	});

	test("status is connected only for ten minutes after an accepted batch", async () => {
		const { hono, routes } = app();
		expect(routes.status(Date.now())).toEqual({
			source: "noop",
			status: "not_connected",
			lastSeenAt: null,
		});
		await post(hono, deflated({ tables: {} }));
		const now = Date.now();
		const seen = routes.status(now);
		expect(seen.status).toBe("connected");
		const lastSeen = Date.parse(seen.lastSeenAt ?? "");
		expect(now - lastSeen).toBeLessThan(5_000);
		expect(routes.status(lastSeen + 10 * 60_000 - 1).status).toBe("connected");
		expect(routes.status(lastSeen + 10 * 60_000).status).toBe("not_connected");
	});
});

describe("unstoredSamples", () => {
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
});
