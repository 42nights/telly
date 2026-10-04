import { ToolRequest } from "@health/contracts/tools";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import { runTool } from "../tools";

/**
 * Agent tool routes, mounted at `/api/families/:familyId` behind sign-in and the membership check.
 * The Fetch.ai worker is the caller. Only `ToolRequest` tools run.
 */
export const toolRoutes = () =>
	new Hono<FamilyEnv>().post(
		"/tools",
		bodyLimit({
			maxSize: 16 * 1024,
			onError: () => {
				throw new ApiFailure("invalid_request", "Request body is too large");
			},
		}),
		async (c) =>
			c.json(
				runTool(
					c.var.db,
					c.var.familyId.toString(),
					await decodeBody(c, ToolRequest),
				),
			),
	);
