import { NodeRuntime } from "@effect/platform-node";
import { type ServerType, serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { createApp } from "./app";
import { type NoopConfig, type ServerConfig, serverConfig } from "./config";
import { openFamilyDb } from "./db";
import { ENV } from "./env.server";
import { type NoopIngest, recordNoopSamples } from "./integrations/noop-ingest";

const noopIngest = (noop: NoopConfig | undefined) =>
	noop === undefined
		? Effect.succeed(undefined)
		: Effect.map(openFamilyDb(noop.db), (db) => ({
				key: noop.key,
				record: recordNoopSamples(db, noop.familyId),
			}));

const listen = (
	port: number,
	config: ServerConfig,
	ingest: NoopIngest | undefined,
) =>
	Effect.callback<ServerType, Error>((resume) => {
		const app = createApp(config, ingest);
		const server = serve({ fetch: app.fetch, hostname: ENV.HOST, port }, () =>
			resume(Effect.succeed(server)),
		);
		server.once("error", (error) => resume(Effect.fail(error)));
	});

const close = (server: ServerType) =>
	Effect.callback<void>((resume) => {
		server.close(() => resume(Effect.void));
	});

// The server is a scoped resource: SIGINT/SIGTERM interrupt the layer, which closes the listener.
const HttpServer = Layer.effectDiscard(
	Effect.gen(function* () {
		const config = serverConfig(ENV);
		const ingest = yield* noopIngest(config.noop);
		yield* Effect.acquireRelease(listen(ENV.PORT, config, ingest), close);
		yield* Effect.log(`server listening on http://${ENV.HOST}:${ENV.PORT}`);
	}),
);

NodeRuntime.runMain(Layer.launch(HttpServer));
