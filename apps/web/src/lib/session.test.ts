import { expect, test } from "bun:test";

import { tokenClaims, tokenExpired } from "@health/contracts/session";

test("tokenClaims reads a base64url JWT payload and rejects garbage", () => {
	// "~~~" and "ü" encode to bytes that use the base64url-only characters and non-ASCII text.
	const claims = { nonce: "~~~?", name: "Müller", exp: 1 };
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	expect(tokenClaims(`h.${payload}.s`)).toEqual(claims);
	expect(tokenClaims("not-a-jwt")).toBeNull();
});

test("tokenExpired drops only a readable exp that has passed", () => {
	const jwt = (claims: object) =>
		`h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
	const now = Math.floor(Date.now() / 1000);
	expect(tokenExpired(jwt({ exp: now - 1 }))).toBe(true);
	expect(tokenExpired(jwt({ exp: now + 60 }))).toBe(false);
	// Without a readable `exp` the server decides, so the client keeps the token.
	expect(tokenExpired(jwt({ sub: "a" }))).toBe(false);
	expect(tokenExpired("not-a-jwt")).toBe(false);
});
