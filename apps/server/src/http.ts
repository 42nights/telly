// The common contract of every signed-in route. Domain modules export Hono route factories from
// `routes/<domain>.ts` typed with `FamilyEnv`; `app.ts` mounts them under `/api/families/:familyId`,
// behind sign-in and the family membership check, so a handler only ever sees a verified caller.
import type { ApiErrorCode } from "@health/contracts";
import type { DbConnection } from "@health/db";
import { Effect, Exit, Schema } from "effect";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { callDb, DbRejected, type FamilyDb } from "./db";

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
	conflict: 409,
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
 * Runs one reducer call through `callDb`: at most 5 s, and it fails at once when the connection
 * drops. Use it as `callReducer(c.var.db, (db) => db.reducers.createFamily({ name }))`. The
 * database's membership rejection becomes `forbidden`; its other refusals are validation messages
 * written by the module, so they become `invalid_request`. An outage stays `DbUnavailable`, which
 * `app.onError` answers as `503 unavailable`.
 */
export const callReducer = async (
	db: FamilyDb,
	call: (connection: DbConnection) => Promise<void>,
): Promise<void> => {
	try {
		await Effect.runPromise(callDb(db, call));
	} catch (error) {
		if (error instanceof DbRejected)
			throw new ApiFailure(
				error.reason === "not a member of this family"
					? "forbidden"
					: "invalid_request",
				error.reason,
			);
		throw error;
	}
};
