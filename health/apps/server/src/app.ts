import type { ApiError, Health, Sources } from "@health/contracts";
import { Effect } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { noopConnection } from "./integrations/noop";

export const createApp = (corsOrigin: string) => {
	const app = new Hono()
		.use(logger())
		.use(
			"/*",
			cors({ origin: corsOrigin, allowMethods: ["GET", "POST", "OPTIONS"] }),
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
		});

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
