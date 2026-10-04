// The alert outbox worker. It runs as the delivery operator identity, reads every family's pending
// deliveries, and sends each through the family delivery transport at least once. A crash between a
// send and its report leaves the claim to expire, so the delivery is sent again with the same
// idempotency key. Alert gating never happens here: the database raised the alert already.
import { Data, Duration, Effect, Schedule } from "effect";
import { callDb, type DbConfig, type FamilyDb, openFamilyDb } from "../db";

/** What a transport delivers to the family. Pass `idempotencyKey` on to the provider. */
export type AlertMessage = {
	readonly alertId: string;
	readonly familyId: string;
	readonly summary: string;
	readonly idempotencyKey: string;
};

/**
 * Why a send did not reach the family. `retryable`: try again later. `rejected`: the provider refused
 * this message for good. `unavailable`: the transport has no credentials or configuration.
 * `reason` is stored and shown to the family: never put provider bodies, tokens, or health data in it.
 */
export class DeliveryFailure extends Data.TaggedError("DeliveryFailure")<{
	readonly kind: "retryable" | "rejected" | "unavailable";
	readonly reason: string;
}> {}

/** A family delivery channel, such as the Grokbot family agent. */
export type AlertTransport = (
	message: AlertMessage,
) => Effect.Effect<void, DeliveryFailure>;

type PendingDelivery = {
	readonly alertId: bigint;
	readonly familyId: bigint;
	readonly summary: string;
	readonly attempts: number;
	readonly status: { readonly tag: string };
	readonly notBefore: { toDate(): Date };
};

const LEASE_SECONDS = 30;
// Shorter than the lease, so no second worker can claim a delivery that is still being sent.
const SEND_TIMEOUT = Duration.seconds(20);
const MAX_ATTEMPTS = 5;
const NO_TRANSPORT = "No family delivery transport is configured";

/** Seconds to wait after failed attempt `attempt` (1-based): 5, 10, 20, 40, then at most 300. */
const retryDelaySeconds = (attempt: number) =>
	Math.min(5 * 2 ** (attempt - 1), 300);

// Each step is bounded and fails at once when the operator connection drops, so a dropped
// connection never stalls the loop; the next poll sees it closed and the worker reopens it.
const deliver = (
	db: FamilyDb,
	transport: AlertTransport | undefined,
	row: PendingDelivery,
) =>
	Effect.gen(function* () {
		const { alertId } = row;
		if (transport === undefined) {
			if (row.status.tag !== "Unavailable")
				yield* callDb(db, ({ reducers }) =>
					reducers.markAlertDeliveryUnavailable({
						alertId,
						reason: NO_TRANSPORT,
					}),
				);
			return;
		}
		// Another worker holds the delivery, or it is not due: leave it to that worker.
		const claim = yield* Effect.result(
			callDb(db, ({ reducers }) =>
				reducers.claimAlertDelivery({ alertId, leaseSeconds: LEASE_SECONDS }),
			),
		);
		if (claim._tag === "Failure") return;
		const sent = yield* Effect.result(
			transport({
				alertId: alertId.toString(),
				familyId: row.familyId.toString(),
				summary: row.summary,
				idempotencyKey: `alert-${alertId}`,
			}).pipe(
				Effect.timeoutOrElse({
					duration: SEND_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new DeliveryFailure({
								kind: "retryable",
								reason: "Delivery timed out",
							}),
						),
				}),
			),
		);
		if (sent._tag === "Success")
			return yield* callDb(db, ({ reducers }) =>
				reducers.markAlertDeliverySent({ alertId }),
			);
		const { kind, reason } = sent.failure;
		if (kind === "unavailable")
			return yield* callDb(db, ({ reducers }) =>
				reducers.markAlertDeliveryUnavailable({ alertId, reason }),
			);
		const attempt = row.attempts + 1;
		const retry = kind === "retryable" && attempt < MAX_ATTEMPTS;
		yield* callDb(db, ({ reducers }) =>
			reducers.markAlertDeliveryFailed({
				alertId,
				error: reason,
				retryAfterSeconds: retry ? retryDelaySeconds(attempt) : undefined,
			}),
		);
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logWarning(`alert ${row.alertId} delivery step failed`, cause),
		),
	);

/**
 * Delivers due alerts forever, polling the operator's pending view. `db` must be the delivery
 * operator's connection. Without a transport, every pending delivery becomes `unavailable`, and a
 * restart with a transport sends them.
 */
export const runAlertOutbox = (
	db: FamilyDb,
	transport: AlertTransport | undefined,
	pollEvery: Duration.Input = Duration.seconds(1),
) =>
	Effect.gen(function* () {
		// The cached queue goes stale when the connection drops; fail so the caller reopens it.
		if (!db.connection.isActive)
			return yield* Effect.fail(new Error("operator connection closed"));
		const now = Date.now();
		const due = [...db.connection.db.pendingAlertDeliveries.iter()].filter(
			(row) =>
				row.notBefore.toDate().getTime() <= now &&
				(transport !== undefined || row.status.tag !== "Unavailable"),
		);
		yield* Effect.forEach(due, (row) => deliver(db, transport, row), {
			concurrency: 4,
			discard: true,
		});
		yield* Effect.sleep(pollEvery);
	}).pipe(Effect.forever);

/**
 * Runs the outbox for the server's lifetime as the delivery operator (`operator`: the module
 * publisher's token), opening the connection again whenever it fails. Without an operator, nothing
 * runs and deliveries stay `queued`.
 */
export const alertOutboxWorker = (
	operator: DbConfig | undefined,
	transport: AlertTransport | undefined,
) =>
	operator === undefined
		? Effect.logWarning(
				"The alert outbox is not configured (ALERT_OPERATOR_TOKEN and the SpacetimeDB settings): deliveries stay queued",
			)
		: Effect.scoped(
				Effect.flatMap(openFamilyDb(operator), (db) =>
					runAlertOutbox(db, transport),
				),
			).pipe(
				Effect.tapCause((cause) =>
					Effect.logWarning("alert outbox stopped; reopening", cause),
				),
				Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
			);
