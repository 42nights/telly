// Phone sign-in (issue #4): the OIDC authorization code flow with PKCE (S256), `state`, and `nonce`,
// through the system browser. The issuer is configured, never chosen here (Google in production).
// Google allows no custom scheme for Android clients, so the phone uses the same web client as the
// web app: the issuer returns to the server's `/api/sign-in/callback`, which sends the reply on to
// `health://sign-in`, and the server's `POST /api/sign-in/token` exchanges the code with the client
// secret. The ID token and the refresh token go to SecureStore (`lib/session.ts`); the ID token is
// the bearer token that the server verifies.
import {
	authorizationUrl,
	discoverAuthorizationEndpoint,
	exchangeSignInCode,
	PHONE_SIGN_IN_RETURN,
	tokenMatches,
} from "@health/contracts/session";
import {
	CryptoDigestAlgorithm,
	CryptoEncoding,
	digestStringAsync,
	randomUUID,
} from "expo-crypto";
import { parse } from "expo-linking";
import { openAuthSessionAsync } from "expo-web-browser";

import { ENV } from "@/src/env";

export const issuer = ENV.EXPO_PUBLIC_OIDC_ISSUER;
const clientId = ENV.EXPO_PUBLIC_OIDC_CLIENT_ID;
const server = ENV.EXPO_PUBLIC_SERVER_URL;
const redirectUri = `${server}/api/sign-in/callback`;

/** Runs one sign-in. Resolves with the new session, or `null` when the person closed the browser. */
export const signIn = async () => {
	if (!issuer || !clientId)
		throw new Error("Sign-in is not set up in this app.");
	const authorizationEndpoint = await discoverAuthorizationEndpoint(issuer);
	// Two random UUIDs: 73 characters from the PKCE verifier alphabet.
	const verifier = `${randomUUID()}-${randomUUID()}`;
	const state = randomUUID();
	const nonce = randomUUID();
	const challenge = (
		await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, {
			encoding: CryptoEncoding.BASE64,
		})
	)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const result = await openAuthSessionAsync(
		authorizationUrl(authorizationEndpoint, {
			clientId,
			redirectUri,
			state,
			nonce,
			challenge,
		}),
		PHONE_SIGN_IN_RETURN,
	);
	if (result.type !== "success") return null;
	const reply = parse(result.url).queryParams ?? {};
	if (typeof reply.error === "string")
		throw new Error(`The sign-in server said: ${reply.error}`);
	if (reply.state !== state || typeof reply.code !== "string")
		throw new Error(
			"This sign-in reply is not from this sign-in. Sign in again.",
		);
	const session = await exchangeSignInCode(server, {
		code: reply.code,
		codeVerifier: verifier,
		redirectUri,
	});
	if (!tokenMatches(session.idToken, issuer, nonce))
		throw new Error("The sign-in server sent a token for another sign-in.");
	return session;
};
