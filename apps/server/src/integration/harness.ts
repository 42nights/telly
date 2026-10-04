// Shared setup for the integration tests in this directory. Each test file starts its own real
// server: `serverConfig` reads an environment, `createApp` builds every route, and `Bun.serve`
// listens on a free 127.0.0.1 port, so requests cross real HTTP. The database is the local
// SpacetimeDB that `bun run db:test` starts. Only external providers are fake, on one test-only
// server: the OIDC issuer (Google), Gemini, ElevenLabs, and the R2 bucket. FinchNode stays off.
// Sign-in takes the web app's path: a code goes to `POST /api/sign-in/token`, the server exchanges
// it at the fake issuer, and the ID token it returns is the caller's bearer token from then on.
import { afterAll, expect } from "bun:test";
import { ApiError, Family } from "@health/contracts";
import { Me } from "@health/contracts/families";
import { SignInToken } from "@health/contracts/session";
import { Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "../app";
import { type Env, serverConfig } from "../config";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
/** Undefined outside `bun run db:test`; wrap each suite in `describe.skipIf(!integration)`. */
export const integration = uri && database ? { uri, database } : undefined;

const AUDIENCE = "telly-integration";
const CLIENT_SECRET = "integration-secret";
const R2_BUCKET = "telly-integration";

/** One request a fake provider received; tests read these to prove what the server sent out. */
export type ProviderCall = {
	readonly method: string;
	readonly path: string;
	readonly body: string;
};
/** Answers a fake provider request. Return undefined to fall through to the default 404. */
type ProviderHandler = (
	request: Request,
	body: string,
) => Response | Promise<Response> | undefined;

type Bucket = Map<
	string,
	{ body: Uint8Array; type: string; lastModified: string }
>;

/** The S3 calls `integrations/r2.ts` makes: PUT, HEAD, GET, DELETE, presigned GET, and a ListObjectsV2 page. */
const fakeR2 = (
	bucket: Bucket,
	request: Request,
	url: URL,
	raw: Uint8Array,
) => {
	// The server signs with a header; a presigned download link signs in its query.
	const signed =
		request.headers.get("authorization")?.startsWith("AWS4-HMAC") ||
		url.searchParams.has("X-Amz-Signature");
	if (!signed) return new Response(null, { status: 403 });
	if (url.pathname === `/${R2_BUCKET}`) {
		const prefix = url.searchParams.get("prefix") ?? "";
		const contents = [...bucket]
			.filter(([key]) => key.startsWith(prefix))
			.map(
				([key, object]) =>
					`<Contents><Key>${key}</Key><Size>${object.body.length}</Size><LastModified>${object.lastModified}</LastModified></Contents>`,
			);
		return new Response(
			`<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`,
			{ headers: { "Content-Type": "application/xml" } },
		);
	}
	const key = decodeURIComponent(url.pathname.slice(R2_BUCKET.length + 2));
	if (request.method === "PUT") {
		bucket.set(key, {
			body: raw,
			type: request.headers.get("content-type") ?? "",
			lastModified: new Date().toISOString(),
		});
		return new Response(null, { status: 200 });
	}
	if (request.method === "DELETE") {
		bucket.delete(key);
		return new Response(null, { status: 204 });
	}
	const object = bucket.get(key);
	if (object === undefined) return new Response(null, { status: 404 });
	return new Response(request.method === "HEAD" ? null : object.body, {
		headers: { "Content-Type": object.type },
	});
};

/**
 * Starts the fake providers and the real server for one test file; both stop after the file.
 * `providers.gemini` and `providers.elevenlabs` start empty: a test sets the reply it needs, and an
 * unset fake answers 503 like an overloaded provider. `env` overrides the server environment, such
 * as an unset provider key to prove what a deploy without it answers.
 */
export const startIntegration = async (env: Partial<Env> = {}) => {
	if (integration === undefined)
		throw new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset");
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const kid = { kid: "integration", alg: "RS256" };
	const publicKey = {
		...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
		...kid,
	};
	const privateKey = {
		...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
		...kid,
	};
	const calls: ProviderCall[] = [];
	const providers: { gemini?: ProviderHandler; elevenlabs?: ProviderHandler } =
		{};
	const bucket: Bucket = new Map();

	const fake = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request): Promise<Response> => {
			const url = new URL(request.url);
			const { pathname } = url;
			const raw = new Uint8Array(await request.arrayBuffer());
			const body = new TextDecoder().decode(raw);
			calls.push({ method: request.method, path: pathname, body });
			if (pathname === "/.well-known/openid-configuration")
				return Response.json({
					issuer,
					jwks_uri: `${issuer}/jwks`,
					token_endpoint: `${issuer}/token`,
				});
			if (pathname === "/jwks") return Response.json({ keys: [publicKey] });
			if (pathname === "/token") {
				// The code is `code:<subject>`; the client secret must arrive from the server.
				const form = new URLSearchParams(body);
				const subject = form.get("code")?.replace(/^code:/, "");
				if (!subject || form.get("client_secret") !== CLIENT_SECRET)
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				return Response.json({ id_token: await idToken(subject) });
			}
			if (pathname.startsWith("/v1beta/"))
				return (
					(await providers.gemini?.(request, body)) ??
					Response.json({ error: { code: 503 } }, { status: 503 })
				);
			if (pathname.startsWith("/v1/"))
				return (
					(await providers.elevenlabs?.(request, body)) ??
					Response.json({ detail: "overloaded" }, { status: 503 })
				);
			if (pathname === `/${R2_BUCKET}` || pathname.startsWith(`/${R2_BUCKET}/`))
				return fakeR2(bucket, request, url, raw);
			return new Response(null, { status: 404 });
		},
	});
	const issuer = `http://127.0.0.1:${fake.port}`;
	const idToken = (subject: string) => {
		const now = Math.floor(Date.now() / 1000);
		return sign(
			{ iss: issuer, sub: subject, aud: AUDIENCE, iat: now, exp: now + 600 },
			privateKey,
			"RS256",
		);
	};

	const app = createApp(
		serverConfig({
			CORS_ORIGIN: "http://localhost:3001",
			OIDC_ISSUER: issuer,
			OIDC_AUDIENCE: AUDIENCE,
			OIDC_CLIENT_SECRET: CLIENT_SECRET,
			SPACETIMEDB_URI: integration.uri,
			SPACETIMEDB_DATABASE: integration.database,
			ELEVENLABS_API_KEY: "integration-elevenlabs",
			ELEVENLABS_VOICE_ID: "integration-voice",
			ELEVENLABS_API_URL: issuer,
			GEMINI_API_KEY: "integration-gemini",
			GEMINI_BASE_URL: issuer,
			FINCHNODE_MODE: "off",
			TELLY_R2_ACCOUNT_ID: "integration",
			TELLY_R2_BUCKET: R2_BUCKET,
			TELLY_R2_ACCESS_KEY_ID: "integration-key",
			TELLY_R2_SECRET_ACCESS_KEY: "integration-secret",
			TELLY_R2_ENDPOINT: issuer,
			// No fake answer uses a tool, so the bridge is never reached; it only has to be set.
			TELLY_FETCH_BRIDGE_URL: issuer,
			TELLY_FETCH_BRIDGE_TOKEN: "integration-bridge",
			REPORT_EMAIL_FROM: "Telly <reports@example.com>",
			...env,
		}),
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: app.fetch,
	});
	const base = `http://127.0.0.1:${server.port}`;
	afterAll(() => {
		server.stop(true);
		fake.stop(true);
	});

	/** Signs `subject` in the way the web app does and returns a client that sends their token. */
	const signIn = async (subject: string): Promise<User> => {
		const exchanged = await fetch(`${base}/api/sign-in/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code: `code:${subject}`,
				codeVerifier: "v".repeat(43),
				redirectUri: "http://localhost:3001/sign-in",
			}),
		});
		expect(exchanged.status).toBe(200);
		const { idToken } = Schema.decodeUnknownSync(SignInToken)(
			await exchanged.json(),
		);
		const call = (method: string, path: string, body?: unknown) =>
			fetch(`${base}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${idToken}`,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const me = await json(Me, await call("GET", "/api/me"));
		return { subject, identity: me.identity, idToken, call };
	};
	return { base, issuer, providers, calls, bucket, signIn };
};

/** A signed-in test user; `call` sends their ID token as the bearer token. */
export type User = {
	readonly subject: string;
	readonly identity: string;
	readonly idToken: string;
	readonly call: (
		method: string,
		path: string,
		body?: unknown,
	) => Promise<Response>;
};

/** Decodes a 2xx reply; any other status fails the test with the server's error body. */
export const json = async <T>(
	schema: Schema.Decoder<T>,
	response: Response,
) => {
	const text = await response.text();
	expect(`${response.status} ${text}`).toMatch(/^2\d\d /);
	return Schema.decodeUnknownSync(schema)(JSON.parse(text));
};

/** The status and `error` code of a failed reply. */
export const errorOf = async (response: Response) =>
	[
		response.status,
		Schema.decodeUnknownSync(ApiError)(await response.json()).error,
	] as const;

/** Creates a family as `owner` the way the web app does and returns its API path. */
export const createFamily = async (owner: User, name = "Rivera") => {
	const family = await json(
		Family,
		await owner.call("POST", "/api/families", { name }),
	);
	return { id: family.id, path: `/api/families/${family.id}` };
};

/** Adds `member` to the family at `path` as `owner`. */
export const addMember = async (owner: User, path: string, member: User) => {
	const added = await owner.call("POST", `${path}/members`, {
		identity: member.identity,
	});
	expect(added.status).toBe(204);
};

/** Shares health records (#26) with `member` as `owner`, as the care-access screen does. */
export const shareHealthRecords = async (
	owner: User,
	path: string,
	member: User,
) => {
	const granted = await owner.call("POST", `${path}/care-access`, {
		identity: member.identity,
		scope: "health_records",
		granted: true,
	});
	expect(granted.status).toBe(204);
};
