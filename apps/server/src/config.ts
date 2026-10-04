import type { AuthConfig } from "./auth";
import type { DbConfig } from "./db";
import type { ElevenLabsConfig } from "./integrations/elevenlabs";
import type { FetchAgentConfig } from "./integrations/fetch";
import { type Finchnode, finchnodeFromEnv } from "./integrations/finchnode";
import type { GeminiConfig } from "./integrations/gemini";
import { type GemmaConfig, gemmaConfigFrom } from "./integrations/gemma";
import type { R2Config } from "./integrations/r2";

export type NoopConfig = {
	readonly key: string;
	readonly familyId: bigint;
	readonly db: DbConfig;
};

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
	/** Undefined when R2 is not configured: the report PDF routes then answer `unavailable`. */
	readonly r2?: R2Config | undefined;
	readonly noop?: NoopConfig | undefined;
};

type Env = {
	readonly CORS_ORIGIN: string;
	readonly OIDC_ISSUER?: string | undefined;
	readonly OIDC_AUDIENCE?: string | undefined;
	readonly OIDC_CLIENT_SECRET?: string | undefined;
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
	readonly TELLY_R2_ACCOUNT_ID?: string | undefined;
	readonly TELLY_R2_BUCKET?: string | undefined;
	readonly TELLY_R2_ACCESS_KEY_ID?: string | undefined;
	readonly TELLY_R2_SECRET_ACCESS_KEY?: string | undefined;
	readonly TELLY_R2_ENDPOINT?: string | undefined;
	readonly NOOP_INGEST_KEY?: string | undefined;
	readonly NOOP_FAMILY_ID?: string | undefined;
	readonly NOOP_SPACETIMEDB_TOKEN?: string | undefined;
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

/** R2 needs all four values; with any missing, the PDF routes answer `unavailable`. */
const r2Config = (env: Env): R2Config | undefined => {
	const {
		TELLY_R2_ACCOUNT_ID: account,
		TELLY_R2_BUCKET: bucket,
		TELLY_R2_ACCESS_KEY_ID: accessKeyId,
		TELLY_R2_SECRET_ACCESS_KEY: secretAccessKey,
	} = env;
	if (!(account && bucket && accessKeyId && secretAccessKey)) return undefined;
	const endpoint =
		env.TELLY_R2_ENDPOINT || `https://${account}.r2.cloudflarestorage.com`;
	return { endpoint, bucket, accessKeyId, secretAccessKey };
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
	{
		OIDC_ISSUER: issuer,
		OIDC_AUDIENCE: audience,
		OIDC_CLIENT_SECRET: clientSecret,
	}: Env,
	db: DbConfig | undefined,
) =>
	issuer && audience && db ? { issuer, audience, clientSecret, db } : undefined;

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

/**
 * Sign-in needs all four values; a partial set is a deployment mistake, so startup fails. The client
 * secret is optional (Google web clients need it) but means nothing without the four.
 */
export const serverConfig = (env: Env): ServerConfig => {
	const { SPACETIMEDB_URI: uri, SPACETIMEDB_DATABASE: database } = env;
	const db = uri && database ? { uri, database } : undefined;
	const auth = allOrNone(
		signIn(env, db),
		[env.OIDC_ISSUER, env.OIDC_AUDIENCE, env.OIDC_CLIENT_SECRET],
		SIGN_IN,
	);
	const noop = allOrNone(
		noopIngest(env, db),
		[env.NOOP_INGEST_KEY, env.NOOP_FAMILY_ID, env.NOOP_SPACETIMEDB_TOKEN],
		"NOOP_INGEST_KEY, NOOP_FAMILY_ID, NOOP_SPACETIMEDB_TOKEN, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE",
	);
	if ((uri || database) && !auth && !noop)
		throw new Error(`Set all of ${SIGN_IN}, or none`);
	const finchnode = finchnodeFromEnv(
		env.FINCHNODE_MODE ?? "off",
		env.FINCHNODE_API_KEY,
	);
	return {
		corsOrigin: env.CORS_ORIGIN,
		voice: {
			apiKey: env.ELEVENLABS_API_KEY,
			voiceId: env.ELEVENLABS_VOICE_ID,
			baseUrl: env.ELEVENLABS_API_URL,
		},
		...(finchnode === undefined ? {} : { finchnode }),
		fetchAgent: fetchAgentConfig(env),
		r2: r2Config(env),
		gemini: env.GEMINI_API_KEY
			? { apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL }
			: undefined,
		gemma: gemmaConfigFrom(env),
		auth,
		noop,
	};
};
