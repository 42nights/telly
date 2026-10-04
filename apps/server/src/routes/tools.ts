import type { ApiError } from "@health/contracts";
import { ToolRequest } from "@health/contracts/tools";
import { Exit, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FamilyDb } from "../db";
import { runTool } from "../tools";

type ToolEnv = { Variables: { db: FamilyDb; familyId: string } };

const decodeRequest = Schema.decodeUnknownExit(ToolRequest);

/**
 * Agent tool routes, relative to `/api/families/:familyId`. The family middleware must already
 * have verified the caller and set `db` and `familyId`. Only `ToolRequest` tools run.
 */
export const toolRoutes = () =>
	new Hono<ToolEnv>().post(
		"/tools",
		bodyLimit({
			maxSize: 16 * 1024,
			onError: (c) =>
				c.json(
					{
						error: "invalid_request",
						message: "Request body is too large",
					} satisfies ApiError,
					413,
				),
		}),
		async (c) => {
			const body: unknown = await c.req.json().catch(() => undefined);
			const request = decodeRequest(body, { onExcessProperty: "error" });
			if (Exit.isFailure(request))
				return c.json(
					{
						error: "invalid_request",
						message:
							"Body is not a supported ToolRequest; see the tools contract",
					} satisfies ApiError,
					400,
				);
			return c.json(runTool(c.var.db, c.var.familyId, request.value));
		},
	);
