import { NodeRuntime } from "@effect/platform-node";
import { type ServerType, serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { alertOutboxWorker } from "./alerts/outbox";
import { createApp } from "./app";
import { type NoopConfig, serverConfig } from "./config";
import { openFamilyDb } from "./db";
import { ENV } from "./env.server";
import { startCloudIMessage } from "./imessage/cloud";
import { type NoopIngest, noopIngest } from "./integrations/noop-ingest";
import { familyAnswer } from "./routes/ask";

const config = serverConfig(ENV);

const openNoopIngest = (noop: NoopConfig | undefined) =>
	noop === undefined
		? Effect.succeed(undefined)
		: Effect.map(openFamilyDb(noop.db), (db) => noopIngest(db, noop.legacy));

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
		const ingest = yield* openNoopIngest(config.noop);
		yield* Effect.acquireRelease(listen(ENV.PORT, ingest), close);
		yield* Effect.log(`server listening on http://${ENV.HOST}:${ENV.PORT}`);
	}),
);

const db = config.auth?.db;
// Delivers alerts to each family's in-app message thread.
const AlertOutbox = Layer.effectDiscard(
	Effect.forkScoped(
		alertOutboxWorker(
			ENV.ALERT_OPERATOR_TOKEN && db
				? { ...db, token: ENV.ALERT_OPERATOR_TOKEN }
				: undefined,
		),
	),
);

// Answers allowlisted iMessage senders through Photon Spectrum Cloud; off without its configuration.
const { imessage } = config;
const ask = familyAnswer({
	gemini: config.gemini,
	fetchAgent: config.fetchAgent,
});
const IMessageAgent = Layer.effectDiscard(
	imessage === undefined
		? Effect.void
		: Effect.gen(function* () {
				yield* Effect.acquireRelease(
					Effect.promise(() =>
						startCloudIMessage(imessage, (familyId, question) =>
							Effect.runPromise(Effect.suspend(() => ask(familyId, question))),
						),
					),
					(app) => Effect.promise(() => app.stop()),
				);
				yield* Effect.log("imessage agent listening");
			}),
);

NodeRuntime.runMain(
	Layer.launch(Layer.mergeAll(HttpServer, AlertOutbox, IMessageAgent)),
);
