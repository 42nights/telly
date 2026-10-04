// Sign-in and family access for every protected route. The server verifies the caller's OIDC token
// (issuer, audience, signature, expiry), then opens the database with that same token. The database
// verifies the token again and derives the caller's identity from it, so membership is decided by
// the database, never by a family id or identity the caller sends.
import { Effect, Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { decodeHeader, verifyWithJwks } from "hono/utils/jwt/jwt";
import { type DbConfig, openFamilyDb } from "./db";
import {
	ApiFailure,
	type AuthEnv,
	type CallerIdentity,
	type FamilyEnv,
} from "./http";

export type AuthConfig = {
	/** Trusted OIDC issuer; tokens must carry exactly this `iss`. */
	readonly issuer: string;
	/** This API's client id; tokens must list it in `aud`. */
	readonly audience: string;
	/** The client secret for the code exchange (Google web clients need one). Never sent to a client. */
	readonly clientSecret?: string | undefined;
	readonly db: Omit<DbConfig, "token">;
};

const Discovery = Schema.Struct({
	issuer: Schema.String,
	jwks_uri: Schema.String,
	token_endpoint: Schema.optional(Schema.String),
});
const Jwks = Schema.Struct({
	keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
// `exp` is required here; the JWT check only rejects an expired `exp` that is present. The profile
// claims come with Google's `email profile` scopes. Only `name` is stored (`GET /api/me`), for the
// members of the caller's families; the others are shown to the caller only.
const Claims = Schema.Struct({
	iss: Schema.String,
	sub: Schema.NonEmptyString,
	exp: Schema.Finite,
	name: Schema.optional(Schema.String),
	given_name: Schema.optional(Schema.String),
	email: Schema.optional(Schema.String),
	picture: Schema.optional(Schema.String),
});

const fetchTimeoutMs = 5_000;
const keysMaxAgeMs = 10 * 60_000;
// An unknown `kid` refetches the keys (provider rotation), but at most this often.
const unknownKidRefetchMs = 60_000;

const getJson = async <T>(url: string, schema: Schema.Decoder<T>) => {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(fetchTimeoutMs),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return Schema.decodeUnknownPromise(schema)(await response.json());
};

/** The issuer's discovery document. It must name the same issuer, so its keys and endpoints are its own. */
export const discover = async (issuer: string) => {
	const discovery = await getJson(
		`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
		Discovery,
	);
	if (discovery.issuer !== issuer)
		throw new Error("discovery names a different issuer");
	return discovery;
};

/** Verifies OIDC tokens against the issuer's published keys, cached in memory. */
const oidcVerifier = (issuer: string, audience: string) => {
	let cache: { keys: HonoJsonWebKey[]; at: number } | undefined;

	const loadKeys = async () => {
		const discovery = await discover(issuer);
		const { keys } = await getJson(discovery.jwks_uri, Jwks);
		cache = { keys: [...keys] as HonoJsonWebKey[], at: Date.now() };
		return cache.keys;
	};

	const keysFor = (kid: string | undefined) => {
		const age =
			cache === undefined ? Number.POSITIVE_INFINITY : Date.now() - cache.at;
		const known = cache?.keys.some((key) => key.kid === kid) ?? false;
		if (
			cache === undefined ||
			age > keysMaxAgeMs ||
			(!known && age > unknownKidRefetchMs)
		)
			return loadKeys().catch(() => {
				throw new ApiFailure(
					"unavailable",
					"The sign-in provider is not reachable",
				);
			});
		return Promise.resolve(cache.keys);
	};

	return async (token: string): Promise<CallerIdentity> => {
		const invalid = new ApiFailure(
			"unauthorized",
			"The sign-in token is not valid",
		);
		let kid: string | undefined;
		try {
			kid = decodeHeader(token).kid;
		} catch {
			throw invalid;
		}
		const keys = await keysFor(kid);
		try {
			const payload = await verifyWithJwks(token, {
				keys,
				allowedAlgorithms: ["RS256", "ES256"],
				verification: { iss: issuer, aud: audience },
			});
			const claims = Schema.decodeUnknownSync(Claims)(payload);
			return {
				issuer: claims.iss,
				subject: claims.sub,
				name: claims.name ?? null,
				givenName: claims.given_name ?? null,
				email: claims.email ?? null,
				picture: claims.picture ?? null,
			};
		} catch {
			throw invalid;
		}
	};
};

/**
 * Requires a valid bearer token, then runs the request with a database connection that acts as the
 * caller, closed when the request ends. Without configuration every protected route answers
 * `unavailable`; it never falls back to an anonymous identity.
 */
export const authenticate = (
	config: AuthConfig | undefined,
): MiddlewareHandler<AuthEnv> => {
	if (config === undefined)
		return async () => {
			throw new ApiFailure(
				"unavailable",
				"Sign-in is not configured on this server",
			);
		};
	const verify = oidcVerifier(config.issuer, config.audience);
	return async (c, next) => {
		const token = /^Bearer (\S+)$/.exec(
			c.req.header("Authorization") ?? "",
		)?.[1];
		if (token === undefined)
			throw new ApiFailure(
				"unauthorized",
				"Sign in and send the token as a bearer token",
			);
		const identity = await verify(token);
		const request = Effect.gen(function* () {
			const db = yield* openFamilyDb({ ...config.db, token }).pipe(
				Effect.timeout("10 seconds"),
				Effect.mapError(
					() => new ApiFailure("unavailable", "The database is not reachable"),
				),
			);
			// The database answers with the token it accepted. Any other token means it issued a new
			// anonymous identity instead of the caller's.
			if (db.token !== token)
				return yield* Effect.fail(
					new ApiFailure(
						"unauthorized",
						"The database did not accept the sign-in token",
					),
				);
			c.set("identity", identity);
			c.set("db", db);
			yield* Effect.promise(() => next());
		});
		await Effect.runPromise(Effect.scoped(request), {
			signal: c.req.raw.signal,
		});
	};
};

/** The path's `familyId` as a database id (u64); anything else is `invalid_request`. */
export const familyIdParam = (raw: string | undefined): bigint => {
	const familyId = /^(0|[1-9][0-9]{0,19})$/.test(raw ?? "")
		? BigInt(raw ?? "")
		: undefined;
	if (familyId === undefined || familyId >= 2n ** 64n)
		throw new ApiFailure(
			"invalid_request",
			"The family id must be a database id",
		);
	return familyId;
};

/** Requires that the caller's database identity is a member of the path's `familyId`. */
export const requireFamilyMember: MiddlewareHandler<FamilyEnv> = async (
	c,
	next,
) => {
	const familyId = familyIdParam(c.req.param("familyId"));
	// `my_families` holds only the families the database identity belongs to.
	const member = c.var.db.connection.db.myFamilies
		.iter()
		.some((row) => row.id === familyId);
	// A family that does not exist is refused the same way, so ids reveal nothing.
	if (!member)
		throw new ApiFailure("forbidden", "You are not a member of this family");
	c.set("familyId", familyId);
	await next();
};
