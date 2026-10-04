// Web sign-in (issue #4): the OIDC authorization code flow with PKCE (S256), `state`, and `nonce`.
// The issuer is configured, never chosen here. The ID token becomes the session token; the server
// checks its signature, issuer, audience, and expiry.
import { Schema } from "effect";

import { ENV } from "@/env";

import { setSessionToken, tokenClaims } from "./session";

const PENDING = "telly.sign-in.pending";

const Discovery = Schema.Struct({
	authorization_endpoint: Schema.String,
	token_endpoint: Schema.String,
});
const Pending = Schema.Struct({
	verifier: Schema.String,
	state: Schema.String,
	nonce: Schema.String,
});
const TokenReply = Schema.Struct({ id_token: Schema.String });
const IdClaims = Schema.Struct({ iss: Schema.String, nonce: Schema.String });

export type SignInConfig = {
	readonly issuer: string;
	readonly clientId: string;
};

/** The configured issuer and client id, or `null` when sign-in is not set up. */
export const signInConfig = (): SignInConfig | null => {
	const issuer = ENV.VITE_OIDC_ISSUER;
	const clientId = ENV.VITE_OIDC_CLIENT_ID;
	return issuer && clientId ? { issuer, clientId } : null;
};

const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

const getJson = async <T>(
	url: string,
	schema: Schema.Decoder<T>,
	init?: RequestInit,
) => {
	const response = await fetch(url, init);
	if (!response.ok)
		throw new Error(`The sign-in server replied HTTP ${response.status}.`);
	return Schema.decodeUnknownSync(schema)(await response.json());
};

const discover = (issuer: string) =>
	getJson(
		`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
		Discovery,
	);

const redirectUri = () => `${location.origin}/sign-in`;

/** Sends the browser to the issuer's sign-in page. */
export const startSignIn = async (config: SignInConfig) => {
	const { authorization_endpoint } = await discover(config.issuer);
	const pending = { verifier: random(), state: random(), nonce: random() };
	sessionStorage.setItem(PENDING, JSON.stringify(pending));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(pending.verifier),
	);
	const url = new URL(authorization_endpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: redirectUri(),
		scope: "openid",
		state: pending.state,
		nonce: pending.nonce,
		code_challenge: base64url(new Uint8Array(digest)),
		code_challenge_method: "S256",
	}).toString();
	location.assign(url);
};

const takePending = () => {
	const raw = sessionStorage.getItem(PENDING);
	sessionStorage.removeItem(PENDING);
	if (raw === null) return null;
	try {
		return Schema.decodeUnknownSync(Pending)(JSON.parse(raw));
	} catch {
		return null;
	}
};

/** Completes the issuer's `?code=&state=` return and stores the ID token. */
export const finishSignIn = async (
	config: SignInConfig,
	reply: { readonly code: string; readonly state: string },
) => {
	const pending = takePending();
	if (pending === null || pending.state !== reply.state)
		throw new Error("This sign-in reply is not from this tab. Sign in again.");
	const { token_endpoint } = await discover(config.issuer);
	const { id_token } = await getJson(token_endpoint, TokenReply, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: reply.code,
			redirect_uri: redirectUri(),
			client_id: config.clientId,
			code_verifier: pending.verifier,
		}),
	});
	const claims = Schema.decodeUnknownOption(IdClaims)(tokenClaims(id_token));
	if (
		claims._tag === "None" ||
		claims.value.iss !== config.issuer ||
		claims.value.nonce !== pending.nonce
	)
		throw new Error("The sign-in server sent a token for another sign-in.");
	setSessionToken(id_token);
};
