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
import { elevenLabsVoice } from "./integrations/elevenlabs";
import { noopConnection } from "./integrations/noop";
import { alertRoutes } from "./routes/alerts";
import { accountRoutes, familyRoutes } from "./routes/families";
import { finchnodeRoutes } from "./routes/finchnode";
import { reportRoutes } from "./routes/reports";
import { toolRoutes } from "./routes/tools";
import { visionRoutes } from "./routes/vision";
import { voiceRoutes } from "./routes/voice";

export const createApp = (config: ServerConfig) => {
	// Mount domain route factories here; each path is relative to `/api/families/:familyId`.
	const family: FamilyRoutes = new Hono<FamilyEnv>()
		.use(requireFamilyMember)
		.route("/", familyRoutes())
		.route("/", alertRoutes())
		.route("/", voiceRoutes(elevenLabsVoice(config.voice)))
		.route("/vision", visionRoutes(config.gemini))
		.route("/", reportRoutes())
		.route("/", finchnodeRoutes(config.finchnode))
		.route("/", toolRoutes());

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
