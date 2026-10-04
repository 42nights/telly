import type { AuthConfig } from "./auth";

export type ServerConfig = {
	readonly corsOrigin: string;
	/** Undefined when sign-in is not configured: protected routes then answer `unavailable`. */
	readonly auth: AuthConfig | undefined;
};

type Env = {
	readonly CORS_ORIGIN: string;
	readonly OIDC_ISSUER?: string | undefined;
	readonly OIDC_AUDIENCE?: string | undefined;
	readonly SPACETIMEDB_URI?: string | undefined;
	readonly SPACETIMEDB_DATABASE?: string | undefined;
};

/** Sign-in needs all four values; a partial set is a deployment mistake, so startup fails. */
export const serverConfig = (env: Env): ServerConfig => {
	const {
		OIDC_ISSUER: issuer,
		OIDC_AUDIENCE: audience,
		SPACETIMEDB_URI: uri,
		SPACETIMEDB_DATABASE: database,
	} = env;
	if (issuer && audience && uri && database)
		return {
			corsOrigin: env.CORS_ORIGIN,
			auth: { issuer, audience, db: { uri, database } },
		};
	if (issuer || audience || uri || database)
		throw new Error(
			"Set all of OIDC_ISSUER, OIDC_AUDIENCE, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE, or none",
		);
	return { corsOrigin: env.CORS_ORIGIN, auth: undefined };
};
