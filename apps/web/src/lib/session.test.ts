import { expect, test } from "bun:test";

import { tokenClaims } from "./session";

test("tokenClaims reads a base64url JWT payload and rejects garbage", () => {
	// "~~~" and "ü" encode to bytes that use the base64url-only characters and non-ASCII text.
	const claims = { nonce: "~~~?", name: "Müller", exp: 1 };
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	expect(tokenClaims(`h.${payload}.s`)).toEqual(claims);
	expect(tokenClaims("not-a-jwt")).toBeNull();
});
