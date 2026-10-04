// Test helpers for family route modules. They run against the local SpacetimeDB that `bun run db:test`
// starts. `familyApp` stands in for sign-in and the membership check (tested in auth.test.ts); the
// database still checks membership for the connection's own identity.
import { ApiError } from "@health/contracts";
import { Effect, Schema, type Scope } from "effect";
import { Hono } from "hono";
import { Identity } from "spacetimedb";
import {
	type DbConfig,
	type FamilyDb,
	openFamilyDb,
	readFamilyRecords,
} from "../db";
import {
	ApiFailure,
	errorStatus,
	type FamilyEnv,
	type FamilyRoutes,
} from "../http";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
export const dbConfig: DbConfig | undefined =
	uri && database ? { uri, database } : undefined;

/** Runs a scoped test body against the local database. */
export const withDb = (
	body: (config: DbConfig) => Effect.Effect<void, unknown, Scope.Scope>,
) =>
	dbConfig === undefined
		? Promise.reject(
				new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset"),
			)
		: Effect.runPromise(Effect.scoped(body(dbConfig)));

/** A new identity with a new family of its own. */
export const openFamily = (config: DbConfig, name: string) =>
	Effect.gen(function* () {
		const db = yield* openFamilyDb(config);
		yield* Effect.promise(() => db.connection.reducers.createFamily({ name }));
		const family = readFamilyRecords(db).families.find((f) => f.name === name);
		if (family === undefined) throw new Error("family was not created");
		return { db, familyId: family.id };
	});

/**
 * Grants or revokes the caller's own care scopes. A founder holds every scope from `createFamily`
 * (#188) and keeps `family_access`, so a test revokes a scope to show what it gates.
 */
export const setOwnScopes = (
	db: FamilyDb,
	familyId: string,
	scopes: readonly string[],
	granted: boolean,
) =>
	Effect.forEach(
		scopes,
		(scope) =>
			Effect.promise(() =>
				db.connection.reducers.setCareGrant({
					familyId: BigInt(familyId),
					member: Identity.fromString(db.identity),
					scope,
					granted,
				}),
			),
		{ discard: true },
	);

/** Mounts `routes` as `app.ts` does, for the caller `db` in `familyId`. */
export const familyApp = (
	db: FamilyDb,
	familyId: string,
	routes: FamilyRoutes,
) =>
	new Hono<FamilyEnv>()
		.use(async (c, next) => {
			c.set("identity", { issuer: "test", subject: db.identity });
			c.set("db", db);
			c.set("familyId", BigInt(familyId));
			await next();
		})
		.route("/", routes)
		.onError((error, c) => {
			if (!(error instanceof ApiFailure)) throw error;
			return c.json(
				{ error: error.code, message: error.message } satisfies ApiError,
				errorStatus[error.code],
			);
		});

/** Sends a request and returns its status and JSON body. */
export const send = (
	app: Hono<FamilyEnv>,
	method: string,
	path: string,
	body?: unknown,
) =>
	Effect.promise(async () => {
		const response = await app.request(path, {
			method,
			...(body === undefined
				? {}
				: {
						body: JSON.stringify(body),
						headers: { "content-type": "application/json" },
					}),
		});
		const text = await response.text();
		return {
			status: response.status,
			json: (text === "" ? null : JSON.parse(text)) as unknown,
		};
	});

/** The status and `ApiError` code of an error response. */
export const failure = (response: { status: number; json: unknown }) => [
	response.status,
	Schema.decodeUnknownSync(ApiError)(response.json).error,
];
