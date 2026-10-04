import type { AuthConfig } from "./auth";
import type { ElevenLabsConfig } from "./integrations/elevenlabs";
import type { FetchAgentConfig } from "./integrations/fetch";
import { type Finchnode, finchnodeFromEnv } from "./integrations/finchnode";
import type { GeminiConfig } from "./integrations/gemini";
import { type GemmaConfig, gemmaConfigFrom } from "./integrations/gemma";

export type ServerConfig = {
	readonly corsOrigin: string;
	/** Undefined when sign-in is not configured: protected routes then answer `unavailable`. */
	readonly auth: AuthConfig | undefined;
	/** Without `apiKey`, voice routes answer `unavailable`. */
	readonly voice: ElevenLabsConfig;
	/** Undefined without `GEMINI_API_KEY`: vision, meal estimate, and question routes answer `unavailable`. */
	readonly gemini?: GeminiConfig | undefined;
	/** Undefined when FinchNode is off: its routes then answer `unavailable`. */
	readonly finchnode?: Finchnode;
	/** Undefined when the Fetch.ai bridge is not configured: agent tool calls then answer `unavailable`. */
	readonly fetchAgent?: FetchAgentConfig | undefined;
	/** Undefined when no Gemma deployment is configured: the cue route then answers `unavailable`. */
	readonly gemma?: GemmaConfig | undefined;
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
	readonly TELLY_FETCH_BRIDGE_URL?: string | undefined;
	readonly TELLY_FETCH_BRIDGE_TOKEN?: string | undefined;
} & Parameters<typeof gemmaConfigFrom>[0];

/** The bridge needs both values; one alone is a deployment mistake, so startup fails. */
const fetchAgentConfig = (env: Env): FetchAgentConfig | undefined => {
	const {
		TELLY_FETCH_BRIDGE_URL: bridgeUrl,
		TELLY_FETCH_BRIDGE_TOKEN: bridgeToken,
	} = env;
	if (bridgeUrl && bridgeToken) return { bridgeUrl, bridgeToken };
	if (bridgeUrl || bridgeToken)
		throw new Error(
			"Set both TELLY_FETCH_BRIDGE_URL and TELLY_FETCH_BRIDGE_TOKEN, or neither",
		);
	return undefined;
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
		fetchAgent: fetchAgentConfig(env),
	};
	const gemini = env.GEMINI_API_KEY
		? { apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL }
		: undefined;
	const gemma = gemmaConfigFrom(env);
	if (issuer && audience && uri && database)
		return {
			...base,
			gemini,
			gemma,
			auth: { issuer, audience, db: { uri, database } },
		};
	if (issuer || audience || uri || database)
		throw new Error(
			"Set all of OIDC_ISSUER, OIDC_AUDIENCE, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE, or none",
		);
	return { ...base, gemini, gemma, auth: undefined };
};
