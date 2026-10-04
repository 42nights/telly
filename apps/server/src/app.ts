import type { ApiError, Health, Sources } from "@health/contracts";
import { Effect } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authenticate, requireFamilyMember } from "./auth";
import type { ServerConfig } from "./config";
import {
	ApiFailure,
	errorStatus,
	type FamilyEnv,
	type FamilyRoutes,
} from "./http";
import { noopConnection } from "./integrations/noop";
import { accountRoutes, familyRoutes } from "./routes/families";

export const createApp = (config: ServerConfig) => {
	// Mount domain route factories here; each path is relative to `/api/families/:familyId`.
	const family: FamilyRoutes = new Hono<FamilyEnv>()
		.use(requireFamilyMember)
		.route("/", familyRoutes());

	const app = new Hono()
		.use(logger())
		.use(
			"/*",
			cors({
				origin: config.corsOrigin,
				allowMethods: ["GET", "POST", "OPTIONS"],
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
	app.onError((error, c) => {
		if (error instanceof ApiFailure)
			return c.json(
				{ error: error.code, message: error.message } satisfies ApiError,
				errorStatus[error.code],
			);
		console.error(error);
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
