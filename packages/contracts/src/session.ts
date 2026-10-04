// The signed-in session token that web and phone clients store (issue #4): the OIDC ID token. The
// clients read its claims only to check their own sign-in and drop an expired token; the server
// verifies the signature, issuer, audience, and expiry.
import { Schema } from "effect";

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
