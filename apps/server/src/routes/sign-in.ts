// Sign-in routes, mounted at `/api/sign-in` before the sign-in check (issue #4). Google's web client
// needs its client secret for the code exchange, so web and phone send the issuer's code here and the
// server adds the secret. The secret never leaves the server. PKCE binds the code to the client that
// started the sign-in, so a code alone is useless here.
import {
	PHONE_SIGN_IN_RETURN,
	SignInCode,
	type SignInToken,
} from "@health/contracts/session";
import { Schema } from "effect";
import { Hono } from "hono";
import { type AuthConfig, discover } from "../auth";
import { ApiFailure, decodeBody } from "../http";

const TokenReply = Schema.Struct({ id_token: Schema.NonEmptyString });
const exchangeTimeoutMs = 10_000;

const issuerDown = () =>
	new ApiFailure("unavailable", "The sign-in provider is not reachable");

export const signInRoutes = (auth: AuthConfig | undefined) =>
	new Hono()
		.post("/token", async (c) => {
			if (auth === undefined)
				throw new ApiFailure(
					"unavailable",
					"Sign-in is not set up on this server",
				);
			const { code, codeVerifier, redirectUri } = await decodeBody(
				c,
				SignInCode,
			);
			const { token_endpoint } = await discover(auth.issuer).catch(() => {
				throw issuerDown();
			});
			if (token_endpoint === undefined) throw issuerDown();
			const response = await fetch(token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					code_verifier: codeVerifier,
					redirect_uri: redirectUri,
					client_id: auth.audience,
					...(auth.clientSecret && { client_secret: auth.clientSecret }),
				}),
				signal: AbortSignal.timeout(exchangeTimeoutMs),
			}).catch(() => {
				throw issuerDown();
			});
			// 4xx: the code, verifier, or redirect is wrong or used. 5xx: the provider failed.
			if (!response.ok)
				throw response.status < 500
					? new ApiFailure(
							"invalid_request",
							"The sign-in provider refused this sign-in. Sign in again.",
						)
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
			return c.json({ idToken: reply.value.id_token } satisfies SignInToken);
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
