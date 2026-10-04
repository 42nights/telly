import type { ApiError, Health, Sources } from "@health/contracts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authenticate, requireFamilyMember } from "./auth";
import type { ServerConfig } from "./config";
import { type DbConfig, DbUnavailable } from "./db";
import {
	ApiFailure,
	errorStatus,
	type FamilyEnv,
	type FamilyRoutes,
} from "./http";
import { type NoopIngest, noopRoutes } from "./integrations/noop-ingest";
import { accountRoutes } from "./routes/families";
import { finderLinkRoutes } from "./routes/finder-link";
import { familyDomainRoutes } from "./routes/index";
import { signInRoutes } from "./routes/sign-in";

export const createApp = (
	config: ServerConfig,
	ingest?: NoopIngest,
	// Photon Spectrum Cloud webhook (src/imessage/cloud.ts); undefined without the iMessage configuration.
	imessageWebhook?: (request: Request) => Promise<Response>,
	// The delivery operator (src/server.ts); undefined: finder links answer `unavailable`.
	operator?: DbConfig,
) => {
	const noop = noopRoutes(ingest);
	// Domain route factories are mounted in `routes/index.ts`, relative to `/api/families/:familyId`.
	const family: FamilyRoutes = new Hono<FamilyEnv>()
		.use(requireFamilyMember)
		.route("/", familyDomainRoutes(config))
		.post("/whoop-token", noop.pushToken);

	const app = new Hono()
		// Redact the NOOP ingest key from logged URLs.
		.use(
			logger((line) => console.log(line.replace(/([?&]k=)[^&\s]*/g, "$1***"))),
		)
		.use(
			"/*",
			cors({
				origin: config.corsOrigin,
				allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			}),
		)
		.get("/health", (c) =>
			c.json({ status: "ok", service: "server" } satisfies Health),
		)
		.get("/api/sources", (c) =>
			c.json({ sources: [noop.status(Date.now())] } satisfies Sources),
		)
		.post("/api/noop/ingest", noop.ingest)
		// Spectrum signs each delivery; the handler verifies it instead of a sign-in.
		.post("/api/imessage/webhook", (c) =>
			imessageWebhook
				? imessageWebhook(c.req.raw)
				: c.json(
						{
							error: "unavailable",
							message: "iMessage is not running",
						} satisfies ApiError,
						503,
					),
		)
		// Sign-in itself cannot require sign-in.
		.route("/api/sign-in", signInRoutes(config.auth))
		// A finder link texted to the wearer is its own credential (#308).
		.route("/api/finder-link", finderLinkRoutes(operator, config.gemini))
		// Every other `/api` route requires sign-in, including routes that do not exist.
		.use("/api/*", authenticate(config.auth))
		.route("/api", accountRoutes())
		.route("/api/families/:familyId", family);

	app.notFound((c) =>
		c.json(
			{
				error: "not_found",
				message: `No route for ${c.req.method} ${c.req.path}`,
			} satisfies ApiError,
			404,
		),
	);
	app.onError((caught, c) => {
		// A closed database connection must read as an outage, never as an empty result.
		const error =
			caught instanceof DbUnavailable
				? new ApiFailure("unavailable", "The database is not reachable")
				: caught;
		if (error instanceof ApiFailure)
			return c.json(
				{ error: error.code, message: error.message } satisfies ApiError,
				errorStatus[error.code],
			);
		// A cancelled request arrives here as an interruption; the client is gone, so do not log it.
		if (!c.req.raw.signal.aborted) console.error(error);
		return c.json(
			{
				error: "internal",
				message: "Internal server error",
			} satisfies ApiError,
			500,
		);
	});
	return app;
};
