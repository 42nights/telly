import type { AuthConfig } from "./auth";
import type { DbConfig } from "./db";

export type NoopConfig = {
	readonly key: string;
	readonly familyId: bigint;
	readonly db: DbConfig;
};

export type ServerConfig = {
	readonly corsOrigin: string;
	/** Undefined when sign-in is not configured: protected routes then answer `unavailable`. */
	readonly auth: AuthConfig | undefined;
	readonly noop?: NoopConfig | undefined;
};

type Env = {
	readonly CORS_ORIGIN: string;
	readonly OIDC_ISSUER?: string | undefined;
	readonly OIDC_AUDIENCE?: string | undefined;
	readonly SPACETIMEDB_URI?: string | undefined;
	readonly SPACETIMEDB_DATABASE?: string | undefined;
	readonly NOOP_INGEST_KEY?: string | undefined;
	readonly NOOP_FAMILY_ID?: string | undefined;
	readonly NOOP_SPACETIMEDB_TOKEN?: string | undefined;
};

const allOrNone = <T>(
	value: T | undefined,
	given: readonly (string | undefined)[],
	names: string,
): T | undefined => {
	if (value === undefined && given.some(Boolean))
		throw new Error(`Set all of ${names}, or none`);
	return value;
};

const signIn = (
	{ OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience }: Env,
	db: DbConfig | undefined,
) => (issuer && audience && db ? { issuer, audience, db } : undefined);

const noopIngest = (
	{
		NOOP_INGEST_KEY: key,
		NOOP_FAMILY_ID: familyId,
		NOOP_SPACETIMEDB_TOKEN: token,
	}: Env,
	db: DbConfig | undefined,
) =>
	key && familyId && token && db
		? { key, familyId: BigInt(familyId), db: { ...db, token } }
		: undefined;

const SIGN_IN =
	"OIDC_ISSUER, OIDC_AUDIENCE, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE";

/** Sign-in needs all four values; a partial set is a deployment mistake, so startup fails. */
export const serverConfig = (env: Env): ServerConfig => {
	const { SPACETIMEDB_URI: uri, SPACETIMEDB_DATABASE: database } = env;
	const db = uri && database ? { uri, database } : undefined;
	const auth = allOrNone(
		signIn(env, db),
		[env.OIDC_ISSUER, env.OIDC_AUDIENCE],
		SIGN_IN,
	);
	const noop = allOrNone(
		noopIngest(env, db),
		[env.NOOP_INGEST_KEY, env.NOOP_FAMILY_ID, env.NOOP_SPACETIMEDB_TOKEN],
		"NOOP_INGEST_KEY, NOOP_FAMILY_ID, NOOP_SPACETIMEDB_TOKEN, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE",
	);
	if ((uri || database) && !auth && !noop)
		throw new Error(`Set all of ${SIGN_IN}, or none`);
	return { corsOrigin: env.CORS_ORIGIN, auth, noop };
};
