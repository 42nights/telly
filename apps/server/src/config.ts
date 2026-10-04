import type { AuthConfig } from "./auth";
import type { DbConfig } from "./db";
import type { ElevenLabsConfig } from "./integrations/elevenlabs";
import type { FetchAgentConfig } from "./integrations/fetch";
import { type Finchnode, finchnodeFromEnv } from "./integrations/finchnode";
import type { GeminiConfig } from "./integrations/gemini";
import { type QwenConfig, qwenConfigFrom } from "./integrations/qwen";
import type { R2Config } from "./integrations/r2";
import type { ResendConfig } from "./integrations/resend";

/** The NOOP ingest connection; `legacy` is the single family of `NOOP_INGEST_KEY`, when set. */
export type NoopConfig = {
	readonly db: DbConfig;
	readonly legacy?: { readonly key: string; readonly familyId: bigint };
};

export type ServerConfig = {
	readonly corsOrigin: string | string[];
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
	/** Undefined when no Qwen deployment is configured: the cue route then answers `unavailable`. */
	readonly qwen?: QwenConfig | undefined;
	/** Undefined when R2 is not configured: the report PDF routes then answer `unavailable`. */
	readonly r2?: R2Config | undefined;
	/** Undefined without `RESEND_API_KEY`: report email routes then answer `unavailable`. */
	readonly reportEmail?: ResendConfig | undefined;
	readonly noop?: NoopConfig | undefined;
	/** Undefined when Photon Spectrum is not configured: no iMessage agent runs. */
	readonly imessage?: IMessageConfig | undefined;
};

/** Photon Spectrum Cloud project and the iMessage addresses allowed to ask, each mapped to its family. */
export type IMessageConfig = {
	readonly projectId: string;
	readonly projectSecret: string;
	readonly senders: ReadonlyMap<string, bigint>;
};

export type Env = {
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
	readonly RESEND_API_KEY?: string | undefined;
	readonly REPORT_EMAIL_FROM: string;
	readonly NOOP_INGEST_KEY?: string | undefined;
	readonly NOOP_FAMILY_ID?: string | undefined;
	readonly NOOP_SPACETIMEDB_TOKEN?: string | undefined;
	readonly TELLY_REQUIRED_KEYS?: string | undefined;
	readonly SPECTRUM_PROJECT_ID?: string | undefined;
	readonly SPECTRUM_PROJECT_SECRET?: string | undefined;
	readonly TELLY_IMESSAGE_SENDERS?: string | undefined;
} & Parameters<typeof qwenConfigFrom>[0];

/** `bun run secrets:pull` lists every key it wrote in TELLY_REQUIRED_KEYS. A listed key that is
 * missing or empty, such as one blanked by a stale host variable, fails startup by name only. */
const requireKeys = (env: Env) => {
	const missing = (env.TELLY_REQUIRED_KEYS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(
			(name) => name && !(env as Readonly<Record<string, unknown>>)[name],
		);
	if (missing.length > 0)
		throw new Error(
			`Required keys are missing or empty: ${missing.join(", ")} (see TELLY_REQUIRED_KEYS)`,
		);
};

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

/** iMessage needs all three values; a partial set or a malformed sender list fails startup. */
const imessageConfig = (env: Env): IMessageConfig | undefined => {
	const {
		SPECTRUM_PROJECT_ID: projectId,
		SPECTRUM_PROJECT_SECRET: projectSecret,
		TELLY_IMESSAGE_SENDERS: list,
	} = env;
	if (!(projectId || projectSecret || list)) return undefined;
	if (!(projectId && projectSecret && list))
		throw new Error(
			"Set all of SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, and TELLY_IMESSAGE_SENDERS, or none",
		);
	const senders = new Map<string, bigint>();
	for (const entry of list.split(",")) {
		const match = /^\s*([^=\s]+)\s*=\s*(\d+)\s*$/.exec(entry);
		if (match === null)
			throw new Error(
				"TELLY_IMESSAGE_SENDERS must be address=familyId pairs separated by commas",
			);
		senders.set(match[1] as string, BigInt(match[2] as string));
	}
	return { projectId, projectSecret, senders };
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

/**
 * `NOOP_SPACETIMEDB_TOKEN` and the database enable per-family WHOOP push tokens. `NOOP_INGEST_KEY`
 * and `NOOP_FAMILY_ID` are a pair for the single legacy family and need the token too.
 */
const noopIngest = (
	{
		NOOP_INGEST_KEY: key,
		NOOP_FAMILY_ID: familyId,
		NOOP_SPACETIMEDB_TOKEN: token,
	}: Env,
	db: DbConfig | undefined,
): NoopConfig | undefined => {
	if (!key !== !familyId)
		throw new Error("Set both NOOP_INGEST_KEY and NOOP_FAMILY_ID, or neither");
	if (!(key || token)) return undefined;
	if (!(token && db))
		throw new Error(
			"NOOP ingest needs NOOP_SPACETIMEDB_TOKEN, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE",
		);
	return {
		db: { ...db, token },
		...(key && familyId ? { legacy: { key, familyId: BigInt(familyId) } } : {}),
	};
};

const SIGN_IN =
	"OIDC_ISSUER, OIDC_AUDIENCE, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE";

/**
 * Sign-in needs all four values; a partial set is a deployment mistake, so startup fails. The client
 * secret is optional (Google web clients need it) but means nothing without the four.
 */
export const serverConfig = (env: Env): ServerConfig => {
	requireKeys(env);
	const { SPACETIMEDB_URI: uri, SPACETIMEDB_DATABASE: database } = env;
	const db = uri && database ? { uri, database } : undefined;
	const auth = allOrNone(
		signIn(env, db),
		[env.OIDC_ISSUER, env.OIDC_AUDIENCE, env.OIDC_CLIENT_SECRET],
		SIGN_IN,
	);
	const noop = noopIngest(env, db);
	if ((uri || database) && !auth && !noop)
		throw new Error(`Set all of ${SIGN_IN}, or none`);
	const finchnode = finchnodeFromEnv(
		env.FINCHNODE_MODE ?? "off",
		env.FINCHNODE_API_KEY,
	);
	return {
		corsOrigin: env.CORS_ORIGIN.split(","),
		voice: {
			apiKey: env.ELEVENLABS_API_KEY,
			voiceId: env.ELEVENLABS_VOICE_ID,
			baseUrl: env.ELEVENLABS_API_URL,
		},
		...(finchnode === undefined ? {} : { finchnode }),
		fetchAgent: fetchAgentConfig(env),
		r2: r2Config(env),
		reportEmail: env.RESEND_API_KEY
			? { apiKey: env.RESEND_API_KEY, from: env.REPORT_EMAIL_FROM }
			: undefined,
		gemini: env.GEMINI_API_KEY
			? { apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL }
			: undefined,
		qwen: qwenConfigFrom(env),
		auth,
		noop,
		imessage: imessageConfig(env),
	};
};
