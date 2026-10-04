// Web sign-in (issue #4): the OIDC authorization code flow with PKCE (S256), `state`, and `nonce`.
// The issuer is configured, never chosen here (Google in production). The server's
// `POST /api/sign-in/token` exchanges the code, because Google's web client needs its client secret,
// which never reaches the browser. The ID token becomes the session token; the server checks its
// signature, issuer, audience, and expiry on every request.
import {
	authorizationUrl,
	exchangeSignInCode,
	tokenMatches,
} from "@health/contracts/session";
import { Schema } from "effect";

import { ENV } from "@/env";

import { setSessionToken } from "./session";

const PENDING = "telly.sign-in.pending";

const Discovery = Schema.Struct({ authorization_endpoint: Schema.String });
const Pending = Schema.Struct({
	verifier: Schema.String,
	state: Schema.String,
	nonce: Schema.String,
});

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

const redirectUri = () => `${location.origin}/sign-in`;

/** Sends the browser to the issuer's sign-in page. */
export const startSignIn = async (config: SignInConfig) => {
	const response = await fetch(
		`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
	);
	if (!response.ok)
		throw new Error(`The sign-in server replied HTTP ${response.status}.`);
	const { authorization_endpoint } = Schema.decodeUnknownSync(Discovery)(
		await response.json(),
	);
	const pending = { verifier: random(), state: random(), nonce: random() };
	sessionStorage.setItem(PENDING, JSON.stringify(pending));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(pending.verifier),
	);
	location.assign(
		authorizationUrl(authorization_endpoint, {
			clientId: config.clientId,
			redirectUri: redirectUri(),
			state: pending.state,
			nonce: pending.nonce,
			challenge: base64url(new Uint8Array(digest)),
		}),
	);
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

/** Completes the issuer's `?code=&state=` return through the server and stores the ID token. */
export const finishSignIn = async (
	config: SignInConfig,
	reply: { readonly code: string; readonly state: string },
) => {
	const pending = takePending();
	if (pending === null || pending.state !== reply.state)
		throw new Error("This sign-in reply is not from this tab. Sign in again.");
	const idToken = await exchangeSignInCode(ENV.VITE_SERVER_URL, {
		code: reply.code,
		codeVerifier: pending.verifier,
		redirectUri: redirectUri(),
	});
	if (!tokenMatches(idToken, config.issuer, pending.nonce))
		throw new Error("The sign-in server sent a token for another sign-in.");
	setSessionToken(idToken);
};
