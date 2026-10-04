import type { FamilyRecords } from "@health/contracts";
import { DbConnection } from "@health/db";
import { Data, Effect, Schedule } from "effect";

/** A local or deployed SpacetimeDB database. Without a token the database issues a new identity. */
export type DbConfig = {
	readonly uri: string;
	readonly database: string;
	readonly token?: string;
};

/** A connection that acts as one database identity, with its family views loaded. */
export type FamilyDb = {
	readonly connection: DbConnection;
	/** Hex identity the database checks family membership against. */
	readonly identity: string;
	/** Credential that reconnects as the same identity. Server-only; never send it to a client. */
	readonly token: string;
};

const views = [
	"SELECT * FROM my_families",
	"SELECT * FROM my_health_samples",
	"SELECT * FROM my_alerts",
	"SELECT * FROM my_messages",
	"SELECT * FROM my_acknowledgements",
	"SELECT * FROM my_reports",
	"SELECT * FROM my_finchnode_links",
	"SELECT * FROM my_alert_thresholds",
	"SELECT * FROM my_alert_deliveries",
	"SELECT * FROM my_care_profiles",
	"SELECT * FROM my_care_instructions",
	"SELECT * FROM my_care_grants",
	"SELECT * FROM my_contact_ladders",
	"SELECT * FROM my_care_needs",
	"SELECT * FROM my_contact_attempts",
	"SELECT * FROM my_meal_facts",
	"SELECT * FROM my_cooking_profiles",
	// Rows only for the delivery operator identity; empty for every family member.
	"SELECT * FROM pending_alert_deliveries",
];

const quality = { Validated: "validated", Unvalidated: "unvalidated" } as const;

/**
 * The database did not answer in time, or the connection dropped. Routes map it to the `unavailable`
 * API error; it never means "no data".
 */
export class DbUnavailable extends Data.TaggedError("DbUnavailable")<{
	readonly reason: string;
}> {}

/** The database answered and refused the call, for example a reducer's membership check. */
export class DbRejected extends Data.TaggedError("DbRejected")<{
	readonly reason: string;
}> {}

// Limits for every database call. Opening a connection is safe to repeat, so it gets two retries
// with backoff; a reducer call is not idempotent, so it gets none. Worst case for an open is about
// 3 × 5 s + 0.75 s.
const connectTimeout = "5 seconds";
const connectRetries = 2;
const callTimeout = "5 seconds";

// Resolves when the connection's socket closes for any reason. The SDK never settles a reducer
// call that is in flight when the socket closes, so `callDb` races the call against this.
const closed = new WeakMap<DbConnection, Promise<void>>();

const connectOnce = (config: DbConfig) =>
	Effect.callback<FamilyDb, DbUnavailable>((resume) => {
		const unavailable = (reason: string) =>
			resume(Effect.fail(new DbUnavailable({ reason })));
		const socketClosed = Promise.withResolvers<void>();
		let builder = DbConnection.builder()
			.withUri(config.uri)
			.withDatabaseName(config.database)
			.onConnect((connection, identity, token) => {
				connection
					.subscriptionBuilder()
					.onApplied(() =>
						resume(
							Effect.succeed({
								connection,
								identity: identity.toHexString(),
								token,
							}),
						),
					)
					.onError(() => {
						connection.disconnect();
						unavailable("subscription failed");
					})
					.subscribe(views);
			})
			.onConnectError(() => unavailable("connect failed"))
			.onDisconnect(() => {
				socketClosed.resolve();
				unavailable("connection closed while opening");
			});
		if (config.token !== undefined) builder = builder.withToken(config.token);
		const connection = builder.build();
		closed.set(connection, socketClosed.promise);
		// Runs when the open is interrupted: a cancelled request, a timeout, or shutdown.
		return Effect.sync(() => connection.disconnect());
	}).pipe(
		Effect.timeoutOrElse({
			duration: connectTimeout,
			orElse: () =>
				Effect.fail(new DbUnavailable({ reason: "connect timed out" })),
		}),
	);

/**
 * Opens a connection for one identity and closes it when the scope ends. The module's reducers and
 * views enforce family membership for that identity; this code adds no access rule of its own.
 * Each attempt is bounded by a timeout, and an interrupted open closes its half-open socket. A
 * dropped connection is not reopened in place: the caller's next scope opens a new one.
 */
export const openFamilyDb = (config: DbConfig) =>
	Effect.acquireRelease(
		connectOnce(config).pipe(
			Effect.retry({
				times: connectRetries,
				schedule: Schedule.exponential("250 millis"),
			}),
		),
		({ connection }) => Effect.sync(() => connection.disconnect()),
		// A cancelled request or shutdown must not wait out the open's timeouts and retries.
		{ interruptible: true },
	);

/**
 * Runs one reducer or procedure call with a bounded timeout. Fails with `DbUnavailable` when the
 * connection is already closed, closes during the call, or does not answer in time, and with
 * `DbRejected` when the module refuses the call (a `SenderError`). Any other rejection is a defect.
 * It never retries: a reducer call is not idempotent.
 */
export const callDb = <A>(
	{ connection }: FamilyDb,
	call: (connection: DbConnection) => Promise<A>,
) => {
	const socketClosed = closed.get(connection);
	if (!connection.isActive || socketClosed === undefined)
		return Effect.fail(new DbUnavailable({ reason: "connection closed" }));
	return Effect.raceFirst(
		Effect.tryPromise({
			try: () => call(connection),
			catch: (error) => {
				if (error instanceof Error && error.name === "SenderError")
					return new DbRejected({ reason: error.message });
				throw error;
			},
		}),
		Effect.promise(() => socketClosed).pipe(
			Effect.andThen(
				Effect.fail(new DbUnavailable({ reason: "connection dropped" })),
			),
		),
	).pipe(
		Effect.timeoutOrElse({
			duration: callTimeout,
			orElse: () =>
				Effect.fail(new DbUnavailable({ reason: "call timed out" })),
		}),
	);
};

/**
 * Translates the identity's database rows into the shared contracts. Throws `DbUnavailable` when
 * the connection has closed: its cached rows are stale and must not pass as current data.
 */
export const readFamilyRecords = ({ connection }: FamilyDb): FamilyRecords => {
	if (!connection.isActive)
		throw new DbUnavailable({
			reason: "connection closed; cached rows are stale",
		});
	const { db } = connection;
	return {
		families: [...db.myFamilies.iter()].map((row) => ({
			id: row.id.toString(),
			name: row.name,
			createdAt: row.createdAt.toISOString(),
		})),
		samples: [...db.myHealthSamples.iter()].map((row) => ({
			id: row.id.toString(),
			familyId: row.familyId.toString(),
			metric: row.metric,
			value: row.value,
			unit: row.unit,
			sourceTime: row.sourceTime.toISOString(),
			receivedAt: row.receivedAt.toISOString(),
			source: row.source,
			synthetic: row.synthetic,
			quality: quality[row.quality.tag],
		})),
		alerts: [...db.myAlerts.iter()].map((row) => ({
			id: row.id.toString(),
			familyId: row.familyId.toString(),
			sampleId: row.sampleId?.toString() ?? null,
			summary: row.summary,
			raisedBy: row.raisedBy.toHexString(),
			createdAt: row.createdAt.toISOString(),
		})),
		messages: [...db.myMessages.iter()].map((row) => ({
			id: row.id.toString(),
			familyId: row.familyId.toString(),
			sender: row.sender.toHexString(),
			body: row.body,
			sentAt: row.sentAt.toISOString(),
			clientId: row.clientId,
		})),
		acknowledgements: [...db.myAcknowledgements.iter()].map((row) => ({
			id: row.id.toString(),
			alertId: row.alertId.toString(),
			familyId: row.familyId.toString(),
			member: row.member.toHexString(),
			acknowledgedAt: row.acknowledgedAt.toISOString(),
		})),
	};
};
