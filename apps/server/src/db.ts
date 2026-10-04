import type { FamilyRecords } from "@health/contracts";
import { DbConnection } from "@health/db";
import { Effect } from "effect";

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
];

const quality = { Validated: "validated", Unvalidated: "unvalidated" } as const;

const connect = (config: DbConfig) =>
	Effect.callback<FamilyDb, Error>((resume) => {
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
					.onError((ctx) => {
						connection.disconnect();
						resume(Effect.fail(ctx.event ?? new Error("subscription failed")));
					})
					.subscribe(views);
			})
			.onConnectError((_ctx, error) => resume(Effect.fail(error)));
		if (config.token !== undefined) builder = builder.withToken(config.token);
		builder.build();
	});

/**
 * Opens a connection for one identity and closes it when the scope ends. The module's reducers and
 * views enforce family membership for that identity; this code adds no access rule of its own.
 */
export const openFamilyDb = (config: DbConfig) =>
	Effect.acquireRelease(connect(config), ({ connection }) =>
		Effect.sync(() => connection.disconnect()),
	);

/** Translates the identity's database rows into the shared contracts. */
export const readFamilyRecords = ({ connection }: FamilyDb): FamilyRecords => {
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
