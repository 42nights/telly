// The alert outbox worker. It runs as the delivery operator identity, reads every family's pending
// deliveries, and sends each through the family delivery transport at least once. A crash between a
// send and its report leaves the claim to expire, so the delivery is sent again with the same
// idempotency key. Alert gating never happens here: the database raised the alert already.
import { Data, Duration, Effect } from "effect";
import type { FamilyDb } from "../db";

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

export const LEASE_SECONDS = 30;
// Shorter than the lease, so no second worker can claim a delivery that is still being sent.
const SEND_TIMEOUT = Duration.seconds(20);
const MAX_ATTEMPTS = 5;
const NO_TRANSPORT = "No family delivery transport is configured";

/** Seconds to wait after failed attempt `attempt` (1-based): 5, 10, 20, 40, then at most 300. */
export const retryDelaySeconds = (attempt: number) =>
	Math.min(5 * 2 ** (attempt - 1), 300);

const call = (operation: () => Promise<void>) =>
	Effect.tryPromise({ try: operation, catch: (error) => error });

const deliver = (
	{ connection: { reducers } }: FamilyDb,
	transport: AlertTransport | undefined,
	row: PendingDelivery,
) =>
	Effect.gen(function* () {
		const { alertId } = row;
		if (transport === undefined) {
			if (row.status.tag !== "Unavailable")
				yield* call(() =>
					reducers.markAlertDeliveryUnavailable({
						alertId,
						reason: NO_TRANSPORT,
					}),
				);
			return;
		}
		// Another worker holds the delivery, or it is not due: leave it to that worker.
		const claim = yield* Effect.result(
			call(() =>
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
			return yield* call(() => reducers.markAlertDeliverySent({ alertId }));
		const { kind, reason } = sent.failure;
		if (kind === "unavailable")
			return yield* call(() =>
				reducers.markAlertDeliveryUnavailable({ alertId, reason }),
			);
		const attempt = row.attempts + 1;
		const retry = kind === "retryable" && attempt < MAX_ATTEMPTS;
		yield* call(() =>
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
