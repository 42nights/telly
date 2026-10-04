import { NodeRuntime } from "@effect/platform-node";
import { type ServerType, serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { createApp } from "./app";
import { serverConfig } from "./config";
import { ENV } from "./env.server";

const listen = (port: number) =>
	Effect.callback<ServerType, Error>((resume) => {
		const app = createApp(serverConfig(ENV));
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
		yield* Effect.acquireRelease(listen(ENV.PORT), close);
		yield* Effect.log(`server listening on http://${ENV.HOST}:${ENV.PORT}`);
	}),
);

NodeRuntime.runMain(Layer.launch(HttpServer));
