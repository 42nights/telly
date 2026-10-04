// The signed-in session that web and phone clients store (issue #4): the OIDC ID token, and the
// issuer's refresh token that renews it (issue #222). The clients read the ID token's claims only to
// check their own sign-in and to renew it before `exp`; the server verifies the signature, issuer,
// audience, and expiry.
//
// Sign-in is the OIDC authorization code flow with PKCE (S256), `state`, and `nonce`. The issuer is
// Google (`https://accounts.google.com`) in production. Google's web client needs its client secret
// for the code exchange and for each renewal, so clients never call the token endpoint: they send the
// code to the server's `POST /api/sign-in/token`, and the refresh token to `POST /api/sign-in/refresh`.
// Google ID tokens last one hour; the refresh token keeps the session until the person signs out.
import { Schema } from "effect";
import { ApiError } from "./index";

/** The JWT payload of `token`, not verified (the server checks the signature). */
export const tokenClaims = (token: string): unknown => {
	try {
		const payload = (token.split(".")[1] ?? "")
			.replace(/-/g, "+")
			.replace(/_/g, "/");
		const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
};

const decodeExp = Schema.decodeUnknownOption(
	Schema.Struct({ exp: Schema.Number }),
);

/** True when `token` has a readable `exp` that has passed, or passes within `withinMs`. Without one, the server decides. */
export const tokenExpired = (token: string, withinMs = 0) => {
	const claims = decodeExp(tokenClaims(token));
	return (
		claims._tag === "Some" && claims.value.exp * 1000 - withinMs <= Date.now()
	);
};

/** The `sessionStorage` keys of the web app's session. The iOS shell writes them before the page loads. */
export const SESSION_KEYS = {
	idToken: "telly.session.token",
	refreshToken: "telly.session.refresh",
} as const;

/** The phone's sign-in return address. The server's `GET /api/sign-in/callback` sends the issuer's reply here. */
export const PHONE_SIGN_IN_RETURN = "health://sign-in";

/** `POST /api/sign-in/token`: the issuer's code, the PKCE verifier, and the `redirect_uri` that got the code. */
export const SignInCode = Schema.Struct({
	code: Schema.NonEmptyString,
	codeVerifier: Schema.String.check(
		Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/),
	),
	redirectUri: Schema.NonEmptyString,
});
export type SignInCode = typeof SignInCode.Type;

/** The reply to `POST /api/sign-in/token` and `/refresh`: the ID token, and on sign-in the refresh token. */
export const SignInToken = Schema.Struct({
	idToken: Schema.NonEmptyString,
	refreshToken: Schema.optionalKey(Schema.NonEmptyString),
});
export type SignInToken = typeof SignInToken.Type;

/** `POST /api/sign-in/refresh`: the refresh token from sign-in. */
export const SignInRefresh = Schema.Struct({
	refreshToken: Schema.NonEmptyString,
});
export type SignInRefresh = typeof SignInRefresh.Type;

/** The issuer's authorization URL for one sign-in attempt. `challenge` is the S256 PKCE challenge. */
export const authorizationUrl = (
	authorizationEndpoint: string,
	request: {
		readonly clientId: string;
		readonly redirectUri: string;
		readonly state: string;
		readonly nonce: string;
		readonly challenge: string;
	},
) => {
	const url = new URL(authorizationEndpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: request.clientId,
		redirect_uri: request.redirectUri,
		scope: "openid",
		// A refresh token. Google sends one only at consent, so every sign-in asks for consent.
		access_type: "offline",
		prompt: "consent",
		state: request.state,
		nonce: request.nonce,
		code_challenge: request.challenge,
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
};

const IdClaims = Schema.Struct({ iss: Schema.String, nonce: Schema.String });

/** True when `idToken` names `issuer` and carries this attempt's `nonce`, so it belongs to this sign-in. */
export const tokenMatches = (
	idToken: string,
	issuer: string,
	nonce: string,
) => {
	const claims = Schema.decodeUnknownOption(IdClaims)(tokenClaims(idToken));
	return (
		claims._tag === "Some" &&
		claims.value.iss === issuer &&
		claims.value.nonce === nonce
	);
};

const postSignIn = async (url: string, request: unknown) => {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	const body: unknown = await response.json().catch(() => null);
	if (response.ok)
		return { status: 200, token: Schema.decodeUnknownSync(SignInToken)(body) };
	const failure = Schema.decodeUnknownOption(ApiError)(body);
	return {
		status: response.status,
		error: new Error(
			failure._tag === "Some"
				? failure.value.message
				: `The server replied HTTP ${response.status}.`,
		),
	};
};

/**
 * Exchanges the issuer's code through `serverUrl`'s `POST /api/sign-in/token`. Rejects with the
 * server's message when the exchange fails.
 */
export const exchangeSignInCode = async (
	serverUrl: string,
	request: SignInCode,
): Promise<SignInToken> => {
	const reply = await postSignIn(`${serverUrl}/api/sign-in/token`, request);
	if (reply.token === undefined) throw reply.error;
	return reply.token;
};

/**
 * Renews the ID token through `serverUrl`'s `POST /api/sign-in/refresh`. Resolves with the new ID
 * token, or `null` when the issuer refused the refresh token (401), so the person must sign in again.
 * Rejects when the server or the issuer cannot answer; the session stays and a later call retries.
 */
export const refreshSignIn = async (
	serverUrl: string,
	refreshToken: string,
): Promise<string | null> => {
	const reply = await postSignIn(`${serverUrl}/api/sign-in/refresh`, {
		refreshToken,
	} satisfies SignInRefresh);
	if (reply.token !== undefined) return reply.token.idToken;
	if (reply.status === 401) return null;
	throw reply.error;
};
