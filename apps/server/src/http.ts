// The common contract of every signed-in route. Domain modules export Hono route factories from
// `routes/<domain>.ts` typed with `FamilyEnv`; `app.ts` mounts them under `/api/families/:familyId`,
// behind sign-in and the family membership check, so a handler only ever sees a verified caller.
import type { ApiErrorCode } from "@health/contracts";
import { Exit, Schema } from "effect";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FamilyDb } from "./db";

/** The caller, as verified from the OIDC token. It never carries the token itself. */
export type CallerIdentity = {
	readonly issuer: string;
	readonly subject: string;
};

/** Every signed-in route: the verified caller and a database connection that acts as them. */
export type AuthEnv = {
	Variables: {
		identity: CallerIdentity;
		/** Opened with the caller's own token. The database rejects writes outside their families. */
		db: FamilyDb;
	};
};

/** Every route under `/api/families/:familyId`: the caller is a member of `familyId`. */
export type FamilyEnv = {
	Variables: AuthEnv["Variables"] & { familyId: bigint };
};

/** What a domain module exports: `export const alertRoutes = (deps) => new Hono<FamilyEnv>()…`. */
export type FamilyRoutes = Hono<FamilyEnv>;

export const errorStatus = {
	invalid_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	internal: 500,
	upstream_error: 502,
	unavailable: 503,
} as const satisfies Record<ApiErrorCode, ContentfulStatusCode>;

/**
 * Throw from a handler or middleware to answer with the typed `ApiError` body and its status. Keep
 * tokens, raw provider errors, images, and health values out of the message.
 */
export class ApiFailure extends Error {
	constructor(
		readonly code: ApiErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ApiFailure";
	}
}

/** Decodes a JSON body with its contract; excess keys fail, so callers cannot add fields. */
export const decodeBody = async <T>(
	c: Context,
	schema: Schema.Decoder<T>,
): Promise<T> => {
	const raw: unknown = await c.req.json().catch(() => {
		throw new ApiFailure("invalid_request", "The body must be JSON");
	});
	const decoded = Schema.decodeUnknownExit(schema)(raw, {
		onExcessProperty: "error",
	});
	if (Exit.isFailure(decoded))
		throw new ApiFailure(
			"invalid_request",
			"The body does not match the request schema",
		);
	return decoded.value;
};

/**
 * Awaits a reducer call. The database's membership rejection becomes `forbidden`; its other
 * rejections are validation messages written by the module, so they become `invalid_request`.
 */
export const callReducer = async (call: Promise<void>): Promise<void> => {
	try {
		await call;
	} catch (error) {
		if (error instanceof Error && error.name === "SenderError")
			throw new ApiFailure(
				error.message === "not a member of this family"
					? "forbidden"
					: "invalid_request",
				error.message,
			);
		throw error;
	}
};
