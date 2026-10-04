// Sign-in routes, mounted at `/api/sign-in` before the sign-in check (issue #4). Google's web client
// needs its client secret for the code exchange and for each renewal, so web and phone send the
// issuer's code or refresh token here and the server adds the secret. The secret never leaves the
// server. PKCE binds the code to the client that started the sign-in, so a code alone is useless
// here. The refresh token (issue #222) is the client's own credential: the server keeps no copy.
import {
	PHONE_SIGN_IN_RETURN,
	SignInCode,
	SignInRefresh,
	type SignInToken,
} from "@health/contracts/session";
import { Schema } from "effect";
import { Hono } from "hono";
import { type AuthConfig, discover } from "../auth";
import { ApiFailure, decodeBody } from "../http";

const TokenReply = Schema.Struct({
	id_token: Schema.NonEmptyString,
	refresh_token: Schema.optionalKey(Schema.NonEmptyString),
});
const exchangeTimeoutMs = 10_000;

const issuerDown = () =>
	new ApiFailure("unavailable", "The sign-in provider is not reachable");

/** Calls the issuer's token endpoint with the client secret. A 4xx reply throws `refused`. */
const issuerToken = async (
	auth: AuthConfig | undefined,
	grant: Record<string, string>,
	refused: ApiFailure,
): Promise<SignInToken> => {
	if (auth === undefined)
		throw new ApiFailure("unavailable", "Sign-in is not set up on this server");
	const { token_endpoint } = await discover(auth.issuer).catch(() => {
		throw issuerDown();
	});
	if (token_endpoint === undefined) throw issuerDown();
	const response = await fetch(token_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			...grant,
			client_id: auth.audience,
			...(auth.clientSecret && { client_secret: auth.clientSecret }),
		}),
		signal: AbortSignal.timeout(exchangeTimeoutMs),
	}).catch(() => {
		throw issuerDown();
	});
	if (!response.ok)
		throw response.status < 500
			? refused
			: new ApiFailure(
					"upstream_error",
					`The sign-in provider replied HTTP ${response.status}`,
				);
	const reply = Schema.decodeUnknownOption(TokenReply)(
		await response.json().catch(() => null),
	);
	if (reply._tag === "None")
		throw new ApiFailure(
			"upstream_error",
			"The sign-in provider sent no ID token",
		);
	const { id_token, refresh_token } = reply.value;
	return {
		idToken: id_token,
		...(refresh_token && { refreshToken: refresh_token }),
	};
};

export const signInRoutes = (auth: AuthConfig | undefined) =>
	new Hono()
		.post("/token", async (c) => {
			const { code, codeVerifier, redirectUri } = await decodeBody(
				c,
				SignInCode,
			);
			// 4xx: the code, verifier, or redirect is wrong or used.
			return c.json(
				await issuerToken(
					auth,
					{
						grant_type: "authorization_code",
						code,
						code_verifier: codeVerifier,
						redirect_uri: redirectUri,
					},
					new ApiFailure(
						"invalid_request",
						"The sign-in provider refused this sign-in. Sign in again.",
					),
				),
			);
		})
		// Renews the one-hour ID token. Only the new ID token goes back: the client keeps its refresh token.
		.post("/refresh", async (c) => {
			const { refreshToken } = await decodeBody(c, SignInRefresh);
			// 4xx: the refresh token was revoked, expired, or never valid.
			const { idToken } = await issuerToken(
				auth,
				{ grant_type: "refresh_token", refresh_token: refreshToken },
				new ApiFailure(
					"unauthorized",
					"The sign-in provider ended this session. Sign in again.",
				),
			);
			return c.json({ idToken } satisfies SignInToken);
		})
		// The phone's `redirect_uri`. Google allows no custom scheme for Android clients, so the issuer
		// returns here (an https address on the web client) and this sends the reply on to the app.
		// ponytail: any app that registers `health://` can run this flow with Telly's client id and get
		// the token of whoever signs in on that phone (the custom-scheme limit in RFC 8252 §8.6).
		// Verified App Links / Universal Links for this return close it when the app ships to stores.
		.get("/callback", (c) => {
			const reply = new URLSearchParams();
			for (const name of ["code", "state", "error"] as const) {
				const value = c.req.query(name);
				if (value !== undefined) reply.set(name, value);
			}
			return c.redirect(`${PHONE_SIGN_IN_RETURN}?${reply}`, 302);
		});
