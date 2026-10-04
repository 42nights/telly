import { ToolRequest } from "@health/contracts/tools";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { familyIdParam, requireFamilyMember } from "../auth";
import { redeem } from "../delegation";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import { runTool } from "../tools";

/** Header that carries a question's delegation (`delegation.ts`) from the server through Fetch.ai. */
export const DELEGATION_HEADER = "x-telly-delegation";

/**
 * Agent tool routes, mounted at `/api/families/:familyId` behind sign-in, before the membership
 * check. The Fetch.ai worker is the caller. With a delegation, the tool reads through the asking
 * member's connection for that family only; without one, the caller must be a member. Only
 * `ToolRequest` tools run.
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
		async (c, next) => {
			const delegation = c.req.header(DELEGATION_HEADER);
			if (delegation === undefined) return requireFamilyMember(c, next);
			const familyId = familyIdParam(c.req.param("familyId"));
			const lent = redeem(delegation, familyId);
			// Unknown, released, expired, or for another family: refused the same way.
			if (lent === undefined)
				throw new ApiFailure(
					"forbidden",
					"The delegation is not valid for this family",
				);
			c.set("db", lent);
			c.set("familyId", familyId);
			await next();
		},
		async (c) =>
			c.json(
				runTool(
					c.var.db,
					c.var.familyId.toString(),
					await decodeBody(c, ToolRequest),
				),
			),
	);
