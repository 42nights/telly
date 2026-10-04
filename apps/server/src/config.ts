import type { AuthConfig } from "./auth";
import type { AgentToolCaller } from "./family-agent";
import type { ElevenLabsConfig } from "./integrations/elevenlabs";
import type { GrokbotConfig } from "./integrations/grokbot";

export type ServerConfig = {
	readonly corsOrigin: string;
	/** Undefined when sign-in is not configured: protected routes then answer `unavailable`. */
	readonly auth: AuthConfig | undefined;
	/** Unset: family questions answer `unavailable`. */
	readonly grokbot?: GrokbotConfig | undefined;
	/** The Fetch.ai Agentverse caller for the agent's data tools. Unset: questions answer `unavailable`. */
	readonly callTool?: AgentToolCaller | undefined;
	/** Unset key: voice answers `unavailable`. */
	readonly elevenLabs?: ElevenLabsConfig;
};

type Env = {
	readonly CORS_ORIGIN: string;
	readonly OIDC_ISSUER?: string | undefined;
	readonly OIDC_AUDIENCE?: string | undefined;
	readonly SPACETIMEDB_URI?: string | undefined;
	readonly SPACETIMEDB_DATABASE?: string | undefined;
	readonly XAI_API_KEY?: string | undefined;
	readonly GROKBOT_MODEL: string;
	readonly XAI_BASE_URL: string;
	readonly ELEVENLABS_API_KEY?: string | undefined;
	readonly ELEVENLABS_VOICE_ID: string;
};

/** Sign-in needs all four values; a partial set is a deployment mistake, so startup fails. */
export const serverConfig = (env: Env): ServerConfig => {
	const {
		OIDC_ISSUER: issuer,
		OIDC_AUDIENCE: audience,
		SPACETIMEDB_URI: uri,
		SPACETIMEDB_DATABASE: database,
	} = env;
	const providers = {
		grokbot: env.XAI_API_KEY
			? {
					apiKey: env.XAI_API_KEY,
					model: env.GROKBOT_MODEL,
					baseUrl: env.XAI_BASE_URL,
				}
			: undefined,
		elevenLabs: {
			apiKey: env.ELEVENLABS_API_KEY,
			voiceId: env.ELEVENLABS_VOICE_ID,
		},
	};
	if (issuer && audience && uri && database)
		return {
			corsOrigin: env.CORS_ORIGIN,
			auth: { issuer, audience, db: { uri, database } },
			...providers,
		};
	if (issuer || audience || uri || database)
		throw new Error(
			"Set all of OIDC_ISSUER, OIDC_AUDIENCE, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE, or none",
		);
	return { corsOrigin: env.CORS_ORIGIN, auth: undefined, ...providers };
};
