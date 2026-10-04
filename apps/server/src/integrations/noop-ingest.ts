import { createHash, timingSafeEqual } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { NoopBatch, type NoopConnection } from "@health/contracts";
import type { WhoopPushToken } from "@health/contracts/families";
import { Schema } from "effect";
import type { Context } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { type FamilyDb, pushTokenFamily } from "../db";
import {
	ApiFailure,
	callReducer,
	type FamilyEnv,
	newSecret,
	sha256Hex,
} from "../http";

export type NoopSample = {
	readonly metric: string;
	readonly value: number;
	readonly unit: string;
	readonly time: number;
	readonly source: string;
};

export type NoopIngest = {
	/** Hex identity of the ingest connection. A family's push token adds it as a member. */
	readonly identity: string;
	/** The single-family `NOOP_INGEST_KEY` and its `NOOP_FAMILY_ID`, when set. */
	readonly legacy?: { readonly key: string; readonly familyId: bigint };
	/** The family that holds this push token hash, or undefined. */
	readonly tokenFamily: (tokenHash: string) => bigint | undefined;
	readonly record: (
		familyId: bigint,
		samples: readonly NoopSample[],
	) => Promise<void>;
};

const daily = [
	["restingHr", "resting_heart_rate", "bpm", 1],
	["avgHrv", "hrv", "ms", 1],
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

/** The newest reading of each device-minute: a later reading in the same minute replaces it. */
const heartRate = (rows: NonNullable<Tables["hrSample"]>) => {
	const newest = new Map<string, NoopSample>();
	for (const { deviceId, ts, bpm } of rows) {
		const minute = `${deviceId}|${Math.floor(ts / 60)}`;
		const seen = newest.get(minute);
		if (seen === undefined || ts * 1000 > seen.time)
			newest.set(minute, {
				metric: "heart_rate",
				value: bpm,
				unit: "bpm",
				time: ts * 1000,
				source: `noop:${deviceId}`,
			});
	}
	return [...newest.values()];
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
								value: Math.round(value * scale * 10) / 10,
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

const slot = ({ source, metric, time }: NoopSample) =>
	metric === "heart_rate"
		? `${source}|${metric}|${Math.floor(time / 60_000)}`
		: `${source}|${metric}|${time}`;

/**
 * The samples to store, given the stored ones in receive order. A heart rate is stored when it is
 * newer than the stored one of its minute, so each push shows; any other metric when its value
 * changed.
 */
export const unstoredSamples = (
	stored: readonly NoopSample[],
	samples: readonly NoopSample[],
) => {
	const latest = new Map<string, NoopSample>();
	for (const sample of stored) latest.set(slot(sample), sample);
	return samples.filter((sample) => {
		const previous = latest.get(slot(sample));
		if (
			previous !== undefined &&
			(sample.metric === "heart_rate"
				? previous.time >= sample.time
				: previous.value === sample.value)
		)
			return false;
		latest.set(slot(sample), sample);
		return true;
	});
};

export const recordNoopSamples =
	(db: FamilyDb, familyId: bigint) =>
	async (samples: readonly NoopSample[]) => {
		const stored = [...db.connection.db.myHealthSamples.iter()]
			.filter((row) => row.familyId === familyId)
			.sort(
				(a, b) =>
					a.receivedAt.toDate().getTime() - b.receivedAt.toDate().getTime(),
			)
			.map((row) => ({
				metric: row.metric,
				value: row.value,
				unit: row.unit,
				time: row.sourceTime.toDate().getTime(),
				source: row.source,
			}));
		for (const sample of unstoredSamples(stored, samples))
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
	};

/** NOOP ingest through one database connection that acts as the ingest identity. */
export const noopIngest = (
	db: FamilyDb,
	legacy?: NoopIngest["legacy"],
): NoopIngest => ({
	identity: db.identity,
	...(legacy === undefined ? {} : { legacy }),
	tokenFamily: (tokenHash) => pushTokenFamily(db, tokenHash),
	record: (familyId, samples) => recordNoopSamples(db, familyId)(samples),
});

const NOOP_FRESH_MS = 10 * 60_000;

export const noopRoutes = (noop: NoopIngest | undefined) => {
	let lastSeenAt: number | undefined;
	const status = (now: number): NoopConnection => ({
		source: "noop",
		status:
			lastSeenAt !== undefined && now - lastSeenAt < NOOP_FRESH_MS
				? "connected"
				: "not_connected",
		lastSeenAt:
			lastSeenAt === undefined ? null : new Date(lastSeenAt).toISOString(),
	});
	const ingest = async (c: Context) => {
		if (noop === undefined)
			throw new ApiFailure("unavailable", "NOOP ingest is not configured");
		// The relay should send `Authorization: Bearer <key>`; `?k=` stays accepted until the Mac relay
		// switches. NOOP's family push sends only the URL, so its token always comes as `?k=`.
		const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
		const given = bearer ?? c.req.query("k");
		const familyId =
			given === undefined
				? undefined
				: noop.legacy !== undefined && noopKeyMatches(given, noop.legacy.key)
					? noop.legacy.familyId
					: noop.tokenFamily(sha256Hex(given));
		if (familyId === undefined)
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
		await noop.record(familyId, samples);
		lastSeenAt = Date.now();
		// NOOP advances its cursor only on 200 (noop/Strand/Collect/TellyPush.swift).
		return c.body(null, 200);
	};
	// `POST /api/families/:familyId/whoop-token`: the module checks the caller may set up sharing.
	const pushToken = async (c: Context<FamilyEnv>) => {
		if (noop === undefined)
			throw new ApiFailure(
				"unavailable",
				"WHOOP push is not set up on this server",
			);
		const { secret: token, hash: tokenHash } = newSecret();
		await callReducer(c.var.db, (db) =>
			db.reducers.setFamilyPushToken({
				familyId: c.var.familyId,
				tokenHash,
				ingest: Identity.fromString(noop.identity),
			}),
		);
		return c.json({ token } satisfies WhoopPushToken, 201);
	};
	return { status, ingest, pushToken };
};
