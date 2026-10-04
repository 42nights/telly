import { createHash, timingSafeEqual } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { NoopBatch } from "@health/contracts";
import { Schema } from "effect";
import type { Context } from "hono";
import { Timestamp } from "spacetimedb";
import type { FamilyDb } from "../db";
import { ApiFailure, callReducer } from "../http";

export type NoopSample = {
	readonly metric: string;
	readonly value: number;
	readonly unit: string;
	readonly time: number;
	readonly source: string;
};

export type NoopIngest = {
	readonly key: string;
	readonly record: (samples: readonly NoopSample[]) => Promise<void>;
};

const daily = [
	["restingHr", "resting_heart_rate", "bpm", 1],
	["avgHrv", "hrv_rmssd", "ms", 1],
	["respRateBpm", "respiratory_rate", "breaths/min", 1],
	["totalSleepMin", "sleep_duration", "min", 1],
	["efficiency", "sleep_efficiency", "%", 100],
	["steps", "daily_steps", "steps", 1],
	["strain", "daily_strain", "noop effort (0-100)", 1],
	["skinTempC", "skin_temperature", "°C", 1],
	["recovery", "recovery", "%", 1],
] as const;

const digest = (value: string) => createHash("sha256").update(value).digest();

const noopKeyMatches = (given: string | undefined, key: string) =>
	given !== undefined && timingSafeEqual(digest(given), digest(key));

type Tables = NoopBatch["tables"];

const heartRate = (rows: NonNullable<Tables["hrSample"]>) => {
	const minutes = new Set<string>();
	const samples: NoopSample[] = [];
	for (const { deviceId, ts, bpm } of rows) {
		const minute = `${deviceId}|${Math.floor(ts / 60)}`;
		if (minutes.has(minute)) continue;
		minutes.add(minute);
		samples.push({
			metric: "heart_rate",
			value: bpm,
			unit: "bpm",
			time: ts * 1000,
			source: `noop:${deviceId}`,
		});
	}
	return samples;
};

const onWrist = (rows: NonNullable<Tables["event"]>): NoopSample[] =>
	rows
		.filter(({ kind }) => /^WRIST_(ON|OFF)\b/.test(kind))
		.map(({ deviceId, ts, kind }) => ({
			metric: "on_wrist",
			value: kind.startsWith("WRIST_ON") ? 1 : 0,
			unit: "boolean",
			time: ts * 1000,
			source: `noop:${deviceId}`,
		}));

const dailyValues = (rows: NonNullable<Tables["dailyMetric"]>): NoopSample[] =>
	rows
		.filter(({ deviceId }) => deviceId.endsWith("-noop"))
		.flatMap((row) => {
			const time = Date.parse(`${row.day}T00:00:00Z`);
			if (Number.isNaN(time)) throw new Error(`invalid day ${row.day}`);
			return daily.flatMap(([column, metric, unit, scale]) => {
				const value = row[column];
				return value === null || value === undefined
					? []
					: [
							{
								metric,
								value: value * scale,
								unit,
								time,
								source: `noop:${row.deviceId}`,
							},
						];
			});
		});

const noopSamples = (body: ArrayBuffer): NoopSample[] => {
	const json = inflateRawSync(Buffer.from(body), {
		maxOutputLength: 64 << 20,
	}).toString("utf8");
	const { tables } = Schema.decodeUnknownSync(NoopBatch)(JSON.parse(json));
	return [
		...heartRate(tables.hrSample ?? []),
		...onWrist(tables.event ?? []),
		...dailyValues(tables.dailyMetric ?? []),
	];
};

const slot = (source: string, metric: string, time: number) =>
	metric === "heart_rate"
		? `${source}|${metric}|${Math.floor(time / 60_000)}`
		: `${source}|${metric}|${time}`;

export const recordNoopSamples =
	(db: FamilyDb, familyId: bigint) =>
	async (samples: readonly NoopSample[]) => {
		const latest = new Map<string, number>();
		const rows = [...db.connection.db.myHealthSamples.iter()]
			.filter((row) => row.familyId === familyId)
			.sort(
				(a, b) =>
					a.receivedAt.toDate().getTime() - b.receivedAt.toDate().getTime(),
			);
		for (const row of rows)
			latest.set(
				slot(row.source, row.metric, row.sourceTime.toDate().getTime()),
				row.value,
			);
		for (const sample of samples) {
			const key = slot(sample.source, sample.metric, sample.time);
			const previous = latest.get(key);
			if (
				previous !== undefined &&
				(sample.metric === "heart_rate" || previous === sample.value)
			)
				continue;
			latest.set(key, sample.value);
			await callReducer(db, (connection) =>
				connection.reducers.recordSample({
					familyId,
					metric: sample.metric,
					value: sample.value,
					unit: sample.unit,
					sourceTime: Timestamp.fromDate(new Date(sample.time)),
					source: sample.source,
					synthetic: false,
					quality: { tag: "Unvalidated" },
				}),
			);
		}
	};

export const noopIngestRoute =
	(noop: NoopIngest | undefined) => async (c: Context) => {
		if (noop === undefined)
			throw new ApiFailure("unavailable", "NOOP ingest is not configured");
		if (!noopKeyMatches(c.req.query("k"), noop.key))
			throw new ApiFailure("unauthorized", "Missing or wrong NOOP ingest key");
		let samples: NoopSample[];
		try {
			samples = noopSamples(await c.req.arrayBuffer());
		} catch {
			throw new ApiFailure(
				"invalid_request",
				"The body is not a raw-deflate NOOP batch",
			);
		}
		await noop.record(samples);
		return c.body(null, 204);
	};
