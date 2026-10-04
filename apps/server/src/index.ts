import { NodeRuntime } from "@effect/platform-node";
import { type ServerType, serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { alertOutboxWorker } from "./alerts/outbox";
import { createApp } from "./app";
import { type NoopConfig, serverConfig } from "./config";
import { openFamilyDb } from "./db";
import { ENV } from "./env.server";
import { startCloudIMessage } from "./imessage/cloud";
import { type NoopIngest, recordNoopSamples } from "./integrations/noop-ingest";
import { familyAnswer } from "./routes/ask";

const config = serverConfig(ENV);

const noopIngest = (noop: NoopConfig | undefined) =>
	noop === undefined
		? Effect.succeed(undefined)
		: Effect.map(openFamilyDb(noop.db), (db) => ({
				key: noop.key,
				record: recordNoopSamples(db, noop.familyId),
			}));

const listen = (
	port: number,
	ingest: NoopIngest | undefined,
	imessageWebhook: ((request: Request) => Promise<Response>) | undefined,
) =>
	Effect.callback<ServerType, Error>((resume) => {
		const app = createApp(config, ingest, imessageWebhook);
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

// Answers allowlisted iMessage senders through Photon Spectrum Cloud; off without its configuration.
const { imessage } = config;
const ask = familyAnswer({
	gemini: config.gemini,
	fetchAgent: config.fetchAgent,
});
const startIMessage = (settings: NonNullable<typeof imessage>) =>
	Effect.acquireRelease(
		Effect.promise(() =>
			startCloudIMessage(settings, (familyId, question) =>
				Effect.runPromise(Effect.suspend(() => ask(familyId, question))),
			),
		),
		(agent) => Effect.promise(() => agent.stop()),
	);

// The server is a scoped resource: SIGINT/SIGTERM interrupt the layer, which closes the listener
// before it stops the iMessage agent.
const HttpServer = Layer.effectDiscard(
	Effect.gen(function* () {
		const ingest = yield* noopIngest(config.noop);
		const agent =
			imessage === undefined ? undefined : yield* startIMessage(imessage);
		yield* Effect.acquireRelease(
			listen(ENV.PORT, ingest, agent?.webhook),
			close,
		);
		yield* Effect.log(`server listening on http://${ENV.HOST}:${ENV.PORT}`);
		if (agent)
			yield* Effect.log("imessage agent listening on /api/imessage/webhook");
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

NodeRuntime.runMain(Layer.launch(Layer.mergeAll(HttpServer, AlertOutbox)));
