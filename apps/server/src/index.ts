import { NodeRuntime } from "@effect/platform-node";
import { type ServerType, serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { alertOutboxWorker } from "./alerts/outbox";
import { createApp } from "./app";
import { type NoopConfig, serverConfig } from "./config";
import { openFamilyDb } from "./db";
import { ENV } from "./env.server";
import { type NoopIngest, recordNoopSamples } from "./integrations/noop-ingest";

const config = serverConfig(ENV);

const noopIngest = (noop: NoopConfig | undefined) =>
	noop === undefined
		? Effect.succeed(undefined)
		: Effect.map(openFamilyDb(noop.db), (db) => ({
				key: noop.key,
				record: recordNoopSamples(db, noop.familyId),
			}));

const listen = (port: number, ingest: NoopIngest | undefined) =>
	Effect.callback<ServerType, Error>((resume) => {
		const app = createApp(config, ingest);
		const server = serve({ fetch: app.fetch, hostname: ENV.HOST, port }, () =>
			resume(Effect.succeed(server)),
		);
		server.once("error", (error) => resume(Effect.fail(error)));
	});

// In-flight requests get this long to finish after SIGTERM. Then their sockets close, which aborts
// each request's signal, interrupts its scope, and closes its database connection. `close` itself
// closes idle keep-alive sockets at once.
const shutdownGraceMs = 3_000;

const close = (server: ServerType) =>
	Effect.callback<void>((resume) => {
		const timer =
			"closeAllConnections" in server
				? setTimeout(() => server.closeAllConnections(), shutdownGraceMs)
				: undefined;
		server.close(() => {
			clearTimeout(timer);
			resume(Effect.void);
		});
	});

// The server is a scoped resource: SIGINT/SIGTERM interrupt the layer, which closes the listener.
const HttpServer = Layer.effectDiscard(
	Effect.gen(function* () {
		const ingest = yield* noopIngest(config.noop);
		yield* Effect.acquireRelease(listen(ENV.PORT, ingest), close);
		yield* Effect.log(`server listening on http://${ENV.HOST}:${ENV.PORT}`);
	}),
);

const db = config.auth?.db;
// ponytail: no family delivery transport exists yet, so every delivery becomes `unavailable`.
// Pass the family delivery transport here when it lands (issue #11).
const AlertOutbox = Layer.effectDiscard(
	Effect.forkScoped(
		alertOutboxWorker(
			ENV.ALERT_OPERATOR_TOKEN && db
				? { ...db, token: ENV.ALERT_OPERATOR_TOKEN }
				: undefined,
			undefined,
		),
	),
);

NodeRuntime.runMain(Layer.launch(Layer.mergeAll(HttpServer, AlertOutbox)));
