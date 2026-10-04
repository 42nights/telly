// The signed-in session token that web and phone clients store (issue #4): the OIDC ID token. The
// clients read its claims only to check their own sign-in and drop an expired token; the server
// verifies the signature, issuer, audience, and expiry.
//
// Sign-in is the OIDC authorization code flow with PKCE (S256), `state`, and `nonce`. The issuer is
// Google (`https://accounts.google.com`) in production. Google's web client needs its client secret
// for the code exchange, so clients never call the token endpoint: they send the code to the server's
// `POST /api/sign-in/token`, which adds the secret.
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

/** True when `token` has a readable `exp` that has passed. Without one, the server decides. */
export const tokenExpired = (token: string) => {
	const claims = decodeExp(tokenClaims(token));
	return claims._tag === "Some" && claims.value.exp * 1000 <= Date.now();
};

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

/** The reply to `POST /api/sign-in/token`: the issuer's ID token, which the client stores. */
export const SignInToken = Schema.Struct({ idToken: Schema.NonEmptyString });
export type SignInToken = typeof SignInToken.Type;

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
		scope: "openid email profile",
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

/** How long the code exchange may take before the client gives up. */
const SIGN_IN_TIMEOUT_MS = 20_000;

/**
 * Exchanges the issuer's code through `serverUrl`'s `POST /api/sign-in/token` and returns the ID
 * token. Rejects with the server's message when the exchange fails, and with "Telly is not
 * answering" when no full reply comes within `SIGN_IN_TIMEOUT_MS`.
 */
export const exchangeSignInCode = async (
	serverUrl: string,
	request: SignInCode,
): Promise<string> => {
	// A timer, not `AbortSignal.timeout`, so the phone's JavaScript engine needs nothing newer.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS);
	const { signal } = controller;
	const notAnswering = new Error("Telly is not answering. Try again.");
	let response: Response;
	let body: unknown;
	try {
		response = await fetch(`${serverUrl}/api/sign-in/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
			signal,
		});
		body = await response.json().catch(() => null);
	} catch (error) {
		throw signal.aborted ? notAnswering : error;
	} finally {
		clearTimeout(timer);
	}
	if (signal.aborted) throw notAnswering;
	if (response.ok) return Schema.decodeUnknownSync(SignInToken)(body).idToken;
	const failure = Schema.decodeUnknownOption(ApiError)(body);
	throw new Error(
		failure._tag === "Some"
			? failure.value.message
			: `The server replied HTTP ${response.status}.`,
	);
};
