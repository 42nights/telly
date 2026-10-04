import type { ApiError, Health, Sources } from "@health/contracts";
import { Effect } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authenticate, requireFamilyMember } from "./auth";
import type { ServerConfig } from "./config";
import { DbUnavailable } from "./db";
import {
	ApiFailure,
	errorStatus,
	type FamilyEnv,
	type FamilyRoutes,
} from "./http";
import { noopConnection } from "./integrations/noop";
import { accountRoutes } from "./routes/families";
import { familyDomainRoutes } from "./routes/index";

export const createApp = (config: ServerConfig) => {
	// Domain route factories are mounted in `routes/index.ts`, relative to `/api/families/:familyId`.
	const family: FamilyRoutes = new Hono<FamilyEnv>()
		.use(requireFamilyMember)
		.route("/", familyDomainRoutes(config));

	const app = new Hono()
		.use(logger())
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
		.get("/api/sources", async (c) => {
			// The request signal interrupts the effect when the client disconnects.
			const noop = await Effect.runPromise(noopConnection, {
				signal: c.req.raw.signal,
			});
			return c.json({ sources: [noop] } satisfies Sources);
		})
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
