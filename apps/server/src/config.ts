import type { AuthConfig } from "./auth";
import type { ElevenLabsConfig } from "./integrations/elevenlabs";

export type ServerConfig = {
	readonly corsOrigin: string;
	/** Undefined when sign-in is not configured: protected routes then answer `unavailable`. */
	readonly auth: AuthConfig | undefined;
	/** Without `apiKey`, voice routes answer `unavailable`. */
	readonly voice: ElevenLabsConfig;
};

type Env = {
	readonly CORS_ORIGIN: string;
	readonly OIDC_ISSUER?: string | undefined;
	readonly OIDC_AUDIENCE?: string | undefined;
	readonly SPACETIMEDB_URI?: string | undefined;
	readonly SPACETIMEDB_DATABASE?: string | undefined;
	readonly ELEVENLABS_API_KEY?: string | undefined;
	readonly ELEVENLABS_VOICE_ID: string;
	readonly ELEVENLABS_API_URL: string;
};

/** Sign-in needs all four values; a partial set is a deployment mistake, so startup fails. */
export const serverConfig = (env: Env): ServerConfig => {
	const {
		OIDC_ISSUER: issuer,
		OIDC_AUDIENCE: audience,
		SPACETIMEDB_URI: uri,
		SPACETIMEDB_DATABASE: database,
	} = env;
	const voice = {
		apiKey: env.ELEVENLABS_API_KEY,
		voiceId: env.ELEVENLABS_VOICE_ID,
		baseUrl: env.ELEVENLABS_API_URL,
	};
	if (issuer && audience && uri && database)
		return {
			corsOrigin: env.CORS_ORIGIN,
			auth: { issuer, audience, db: { uri, database } },
			voice,
		};
	if (issuer || audience || uri || database)
		throw new Error(
			"Set all of OIDC_ISSUER, OIDC_AUDIENCE, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE, or none",
		);
	return { corsOrigin: env.CORS_ORIGIN, auth: undefined, voice };
};
