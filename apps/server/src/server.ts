import { type ServerType, serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { alertOutboxWorker } from "./alerts/outbox";
import { createApp } from "./app";
import type { NoopConfig, ServerConfig } from "./config";
import { openFamilyDb } from "./db";
import { startCloudIMessage } from "./imessage/cloud";
import { photoReader, wearerActions } from "./imessage/finder";
import { wearerPhones, wearerTextWorker } from "./imessage/texts";
import { type NoopIngest, noopIngest } from "./integrations/noop-ingest";
import { familyAnswer } from "./routes/ask";

export type ListenEnv = {
	readonly HOST: string;
	readonly PORT: number;
	readonly ALERT_OPERATOR_TOKEN?: string | undefined;
};

const openNoopIngest = (noop: NoopConfig | undefined) =>
	noop === undefined
		? Effect.succeed(undefined)
		: Effect.map(openFamilyDb(noop.db), (db) => noopIngest(db, noop.legacy));

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

/**
 * The HTTP server, the iMessage agent, the alert outbox, and the wearer text outbox, each closed
 * when the layer's scope ends.
 */
export const serverLayer = (config: ServerConfig, env: ListenEnv) => {
	// The module publisher's identity: it delivers alerts and wearer texts and opens finder links.
	const db = config.auth?.db;
	const operator =
		env.ALERT_OPERATOR_TOKEN && db
			? { ...db, token: env.ALERT_OPERATOR_TOKEN }
			: undefined;
	const listen = (
		ingest: NoopIngest | undefined,
		imessageWebhook: ((request: Request) => Promise<Response>) | undefined,
	) =>
		Effect.callback<ServerType, Error>((resume) => {
			const app = createApp(config, ingest, imessageWebhook, operator);
			const server = serve(
				{ fetch: app.fetch, hostname: env.HOST, port: env.PORT },
				() => resume(Effect.succeed(server)),
			);
			server.once("error", (error) => resume(Effect.fail(error)));
		});

	// Answers allowlisted iMessage senders through Photon Spectrum Cloud; off without its configuration.
	const { imessage } = config;
	const ask = familyAnswer({
		gemini: config.gemini,
		fetchAgent: config.fetchAgent,
	});
	// A failed start (Photon outage, wrong secret, missing gRPC peers) must not take the API down:
	// it is logged, and the webhook route answers `unavailable`.
	const startIMessage = (settings: NonNullable<typeof imessage>) =>
		Effect.acquireRelease(
			Effect.tryPromise(() =>
				startCloudIMessage(
					settings,
					(familyId, question) =>
						Effect.runPromise(Effect.suspend(() => ask(familyId, question))),
					operator === undefined
						? undefined
						: wearerActions(
								operator,
								settings.appUrl,
								photoReader(config.gemini),
							),
				),
			),
			(agent) => Effect.promise(() => agent.stop()),
		).pipe(
			Effect.catch((error) =>
				Effect.as(
					Effect.logError(
						"imessage agent did not start; iMessage is unavailable",
						error.cause,
					),
					undefined,
				),
			),
		);

	// The listener closes before the iMessage agent stops.
	const HttpServer = Layer.effectDiscard(
		Effect.gen(function* () {
			const ingest = yield* openNoopIngest(config.noop);
			const agent =
				imessage === undefined ? undefined : yield* startIMessage(imessage);
			yield* Effect.acquireRelease(listen(ingest, agent?.webhook), close);
			yield* Effect.log(`server listening on http://${env.HOST}:${env.PORT}`);
			if (agent)
				yield* Effect.log("imessage agent listening on /api/imessage/webhook");
			// Texts the wearer what the wearer screens used to show (#308).
			if (agent && imessage && operator)
				yield* Effect.forkScoped(
					wearerTextWorker(
						operator,
						agent.text,
						wearerPhones(imessage.senders),
					),
				);
		}),
	);

	// Delivers alerts to each family's in-app message thread.
	const AlertOutbox = Layer.effectDiscard(
		Effect.forkScoped(alertOutboxWorker(operator)),
	);

	return Layer.mergeAll(HttpServer, AlertOutbox);
};
