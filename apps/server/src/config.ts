import type { AuthConfig } from "./auth";
import type { ElevenLabsConfig } from "./integrations/elevenlabs";
import { type Finchnode, finchnodeFromEnv } from "./integrations/finchnode";
import type { GeminiConfig } from "./integrations/gemini";

export type ServerConfig = {
	readonly corsOrigin: string;
	/** Undefined when sign-in is not configured: protected routes then answer `unavailable`. */
	readonly auth: AuthConfig | undefined;
	/** Without `apiKey`, voice routes answer `unavailable`. */
	readonly voice: ElevenLabsConfig;
	/** Undefined without `GEMINI_API_KEY`: vision routes then answer `unavailable`. */
	readonly gemini?: GeminiConfig | undefined;
	/** Undefined when FinchNode is off: its routes then answer `unavailable`. */
	readonly finchnode?: Finchnode;
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
	readonly GEMINI_API_KEY?: string | undefined;
	readonly GEMINI_BASE_URL: string;
	readonly FINCHNODE_MODE?: "off" | "demo" | "api" | undefined;
	readonly FINCHNODE_API_KEY?: string | undefined;
};

/** Sign-in needs all four values; a partial set is a deployment mistake, so startup fails. */
export const serverConfig = (env: Env): ServerConfig => {
	const {
		OIDC_ISSUER: issuer,
		OIDC_AUDIENCE: audience,
		SPACETIMEDB_URI: uri,
		SPACETIMEDB_DATABASE: database,
	} = env;
	const finchnode = finchnodeFromEnv(
		env.FINCHNODE_MODE ?? "off",
		env.FINCHNODE_API_KEY,
	);
	const base = {
		corsOrigin: env.CORS_ORIGIN,
		voice: {
			apiKey: env.ELEVENLABS_API_KEY,
			voiceId: env.ELEVENLABS_VOICE_ID,
			baseUrl: env.ELEVENLABS_API_URL,
		},
		...(finchnode === undefined ? {} : { finchnode }),
	};
	const gemini = env.GEMINI_API_KEY
		? { apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL }
		: undefined;
	if (issuer && audience && uri && database)
		return {
			...base,
			gemini,
			auth: { issuer, audience, db: { uri, database } },
		};
	if (issuer || audience || uri || database)
		throw new Error(
			"Set all of OIDC_ISSUER, OIDC_AUDIENCE, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE, or none",
		);
	return { ...base, gemini, auth: undefined };
};
