// Runs against a real local SpacetimeDB: `bun run db:test` publishes the module as a fresh identity,
// which becomes the delivery operator, and passes its token in SPACETIMEDB_OPERATOR_TOKEN. The
// transports here are local test doubles: they prove the outbox protocol, not delivery by a provider.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Timestamp } from "spacetimedb";
import {
	type DbConfig,
	type FamilyDb,
	openFamilyDb,
	readFamilyRecords,
} from "../db";
import { type AlertMessage, DeliveryFailure, runAlertOutbox } from "./outbox";
import { readAlerts, readThresholds } from "./records";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const operatorToken = process.env.SPACETIMEDB_OPERATOR_TOKEN;
const config: DbConfig | undefined =
	uri && database ? { uri, database } : undefined;

const run = (
	body: (config: DbConfig) => Effect.Effect<void, unknown, never>,
) =>
	config === undefined
		? Promise.reject(
				new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset"),
			)
		: Effect.runPromise(body(config));

const openOperator = (config: DbConfig) =>
	operatorToken === undefined
		? Effect.die(new Error("SPACETIMEDB_OPERATOR_TOKEN is unset"))
		: openFamilyDb({ ...config, token: operatorToken });

/** A new family owned by `db`, with a heart-rate threshold above 110 bpm and 5 minutes of freshness. */
const heartFamily = (db: FamilyDb) =>
	Effect.gen(function* () {
		const name = crypto.randomUUID();
		yield* Effect.promise(() => db.connection.reducers.createFamily({ name }));
		const family = readFamilyRecords(db).families.find((f) => f.name === name);
		if (family === undefined) throw new Error("family was not created");
		const familyId = BigInt(family.id);
		yield* Effect.promise(() =>
			db.connection.reducers.setAlertThreshold({
				familyId,
				metric: "heart_rate",
				direction: { tag: "Above" },
				limit: 110,
				unit: "bpm",
				maxAgeSeconds: 300,
			}),
		);
		return familyId;
	});

const record = (
	db: FamilyDb,
	familyId: bigint,
	value: number,
	{
		sourceTime = Timestamp.fromDate(new Date(Date.now() - 1000)),
		unit = "bpm",
		validated = true,
	}: { sourceTime?: Timestamp; unit?: string; validated?: boolean } = {},
) =>
	Effect.promise(() =>
		db.connection.reducers.recordSample({
			familyId,
			metric: "heart_rate",
			value,
			unit,
			sourceTime,
			source: "synthetic-demo",
			synthetic: true,
			quality: { tag: validated ? "Validated" : "Unvalidated" },
		}),
	);

/**
 * Polls `read` until it returns a value. Another connection's writes and database-clock leases arrive
 * asynchronously, and the SDK exposes no event for "this row reached this state".
 */
const eventually = <T>(read: () => T | undefined, timeoutMs = 10_000) =>
	Effect.promise(async () => {
		for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
			const value = read();
			if (value !== undefined) return value;
			await Bun.sleep(50);
		}
		throw new Error("timed out waiting for the database");
	});

const rejection = (operation: () => Promise<void>) =>
	Effect.promise(() =>
		operation().then(
			() => "accepted",
			(error: unknown) => String(error),
		),
	);

describe.skipIf(config === undefined)("threshold alerts and outbox", () => {
	test("only a fresh, validated sample strictly beyond the limit raises an alert, with its delivery", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFamilyDb(config);
					const familyId = yield* heartFamily(db);
					const stale = Timestamp.fromDate(new Date(Date.now() - 600_000));
					yield* record(db, familyId, 110);
					yield* record(db, familyId, 140, { validated: false });
					yield* record(db, familyId, 140, { unit: "beats/min" });
					yield* record(db, familyId, 140, { sourceTime: stale });
					expect(readAlerts(db, familyId.toString())).toEqual([]);

					yield* record(db, familyId, 110.5);
					const alerts = readAlerts(db, familyId.toString());
					expect(alerts).toHaveLength(1);
					expect(alerts[0]?.alert.summary).toStartWith(
						"Synthetic: heart_rate 110.5 bpm at ",
					);
					expect(alerts[0]?.sample).toMatchObject({
						value: 110.5,
						source: "synthetic-demo",
						synthetic: true,
						quality: "validated",
					});
					// Written in the same transaction as the alert.
					expect(alerts[0]?.delivery).toMatchObject({
						status: "queued",
						attempts: 0,
					});
				}),
			),
		));

	test("a replayed or reordered sample raises each reading's alert once", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFamilyDb(config);
					const familyId = yield* heartFamily(db);
					const newer = Timestamp.fromDate(new Date(Date.now() - 1000));
					const older = Timestamp.fromDate(new Date(Date.now() - 2000));
					yield* record(db, familyId, 150, { sourceTime: newer });
					yield* record(db, familyId, 140, { sourceTime: older });
					yield* record(db, familyId, 150, { sourceTime: newer });
					yield* record(db, familyId, 140, { sourceTime: older });
					const alerts = readAlerts(db, familyId.toString());
					expect(alerts.map((a) => a.sample?.value).sort()).toEqual([140, 150]);
					expect(readFamilyRecords(db).samples).toHaveLength(4);
				}),
			),
		));

	test("another family cannot read or change thresholds, and no member can work the outbox", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const owner = yield* openFamilyDb(config);
					const outsider = yield* openFamilyDb(config);
					const familyId = yield* heartFamily(owner);
					yield* record(owner, familyId, 150);
					const [threshold] = readThresholds(owner, familyId.toString());
					const [alert] = readAlerts(owner, familyId.toString());
					if (threshold === undefined || alert === undefined)
						throw new Error("threshold or alert missing");
					const alertId = BigInt(alert.alert.id);

					expect(readThresholds(outsider, familyId.toString())).toEqual([]);
					expect([...outsider.connection.db.myAlertDeliveries.iter()]).toEqual(
						[],
					);
					const theirs = outsider.connection.reducers;
					expect(
						yield* rejection(() =>
							theirs.setAlertThreshold({
								familyId,
								metric: "heart_rate",
								direction: { tag: "Above" },
								limit: 999,
								unit: "bpm",
								maxAgeSeconds: 300,
							}),
						),
					).toBe("SenderError: not a member of this family");
					expect(
						yield* rejection(() =>
							theirs.removeAlertThreshold({
								thresholdId: BigInt(threshold.id),
							}),
						),
					).toBe("SenderError: not a member of this family");

					// Family members, the owner included, are not the delivery operator.
					for (const member of [owner, outsider]) {
						expect([
							...member.connection.db.pendingAlertDeliveries.iter(),
						]).toEqual([]);
						const { reducers } = member.connection;
						const steps = [
							() => reducers.claimAlertDelivery({ alertId, leaseSeconds: 30 }),
							() => reducers.markAlertDeliverySent({ alertId }),
							() =>
								reducers.markAlertDeliveryFailed({
									alertId,
									error: "x",
									retryAfterSeconds: undefined,
								}),
							() =>
								reducers.markAlertDeliveryUnavailable({ alertId, reason: "x" }),
						];
						for (const step of steps)
							expect(yield* rejection(step)).toBe(
								"SenderError: not the delivery operator",
							);
					}
					expect(readThresholds(owner, familyId.toString())).toEqual([
						threshold,
					]);
					expect(
						readAlerts(owner, familyId.toString())[0]?.delivery?.status,
					).toBe("queued");
				}),
			),
		));

	test("without a transport, deliveries become unavailable, never sent", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFamilyDb(config);
					const operator = yield* openOperator(config);
					// The operator reads the outbox but no family's records.
					expect(readFamilyRecords(operator).alerts).toEqual([]);
					const familyId = yield* heartFamily(db);
					yield* record(db, familyId, 150);
					yield* Effect.forkScoped(
						runAlertOutbox(operator, undefined, "50 millis"),
					);
					const delivery = yield* eventually(() => {
						const found = readAlerts(db, familyId.toString())[0]?.delivery;
						return found?.status === "unavailable" ? found : undefined;
					});
					expect(delivery).toMatchObject({
						attempts: 0,
						lastError: "No family delivery transport is configured",
					});
				}),
			),
		));

	test("a delivery claimed by a worker that stopped is sent once after its lease, and acknowledgement stays separate", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFamilyDb(config);
					const operator = yield* openOperator(config);
					const familyId = yield* heartFamily(db);
					yield* record(db, familyId, 150);
					const alertId = BigInt(
						readAlerts(db, familyId.toString())[0]?.alert.id ?? "",
					);
					// A previous worker claimed the delivery and stopped before reporting.
					yield* eventually(() =>
						[...operator.connection.db.pendingAlertDeliveries.iter()].find(
							(row) => row.alertId === alertId,
						),
					);
					yield* Effect.promise(() =>
						operator.connection.reducers.claimAlertDelivery({
							alertId,
							leaseSeconds: 2,
						}),
					);
					const claimedAt = Date.now();

					const sent: { message: AlertMessage; at: number }[] = [];
					yield* Effect.forkScoped(
						runAlertOutbox(
							operator,
							(message) =>
								Effect.sync(() => {
									if (message.familyId === familyId.toString())
										sent.push({ message, at: Date.now() });
								}),
							"50 millis",
						),
					);
					const delivery = yield* eventually(() => {
						const found = readAlerts(db, familyId.toString())[0]?.delivery;
						return found?.status === "sent" ? found : undefined;
					});
					expect(delivery.attempts).toBe(2);
					expect(sent).toHaveLength(1);
					expect(sent[0]?.at).toBeGreaterThanOrEqual(claimedAt + 1000);
					expect(sent[0]?.message).toEqual({
						alertId: alertId.toString(),
						familyId: familyId.toString(),
						summary: expect.stringMatching(/^Synthetic: heart_rate 150 bpm /),
						idempotencyKey: `alert-${alertId}`,
					});

					// A late failure report never undoes a sent delivery.
					yield* Effect.promise(() =>
						operator.connection.reducers.markAlertDeliveryFailed({
							alertId,
							error: "late",
							retryAfterSeconds: undefined,
						}),
					);
					yield* Effect.promise(() =>
						db.connection.reducers.acknowledgeAlert({ alertId }),
					);
					yield* Effect.promise(() =>
						db.connection.reducers.acknowledgeAlert({ alertId }),
					);
					const [alert] = readAlerts(db, familyId.toString());
					expect(alert?.delivery?.status).toBe("sent");
					expect(alert?.acknowledgements.map((a) => a.member)).toEqual([
						db.identity,
					]);
					expect(sent).toHaveLength(1);
				}),
			),
		));

	test("a retryable failure waits with backoff; a rejection fails for good", () =>
		run((config) =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFamilyDb(config);
					const operator = yield* openOperator(config);
					const familyId = yield* heartFamily(db);
					const now = Date.now();
					yield* record(db, familyId, 150, {
						sourceTime: Timestamp.fromDate(new Date(now - 1000)),
					});
					yield* record(db, familyId, 160, {
						sourceTime: Timestamp.fromDate(new Date(now - 2000)),
					});
					yield* Effect.forkScoped(
						runAlertOutbox(
							operator,
							(message) =>
								Effect.fail(
									message.summary.includes(" 150 bpm")
										? new DeliveryFailure({ kind: "retryable", reason: "busy" })
										: new DeliveryFailure({
												kind: "rejected",
												reason: "refused",
											}),
								),
							"50 millis",
						),
					);
					const byValue = yield* eventually(() => {
						const alerts = readAlerts(db, familyId.toString());
						const settled =
							alerts.length === 2 && alerts.every((a) => a.delivery?.lastError);
						return settled
							? new Map(alerts.map((a) => [a.sample?.value, a.delivery]))
							: undefined;
					});
					expect(byValue.get(150)).toMatchObject({
						status: "queued",
						attempts: 1,
						lastError: "busy",
					});
					expect(byValue.get(160)).toMatchObject({
						status: "failed",
						attempts: 1,
						lastError: "refused",
					});
					// The database holds the retry for the first backoff, 5 s after the failed attempt.
					const retry = [
						...operator.connection.db.pendingAlertDeliveries.iter(),
					].find((row) => row.familyId === familyId);
					expect(
						Number(
							(retry?.notBefore.microsSinceUnixEpoch ?? 0n) -
								(retry?.updatedAt.microsSinceUnixEpoch ?? 0n),
						),
					).toBe(5_000_000);
				}),
			),
		));
});
