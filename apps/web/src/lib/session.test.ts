import { describe, expect, test } from "bun:test";
import { tokenClaims, tokenExpired } from "@health/contracts/session";
import { setupDom } from "@/lib/test/dom";

import { getSessionToken, onSessionChange, setSessionToken } from "./session";

// happy-dom provides sessionStorage and clears it after each test.
setupDom();
const KEY = "telly.session.token";

const jwt = (claims: object) =>
	`h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

test("tokenClaims reads a base64url JWT payload and rejects garbage", () => {
	// "~~~" and "ü" encode to bytes that use the base64url-only characters and non-ASCII text.
	const claims = { nonce: "~~~?", name: "Müller", exp: 1 };
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	expect(tokenClaims(`h.${payload}.s`)).toEqual(claims);
	expect(tokenClaims("not-a-jwt")).toBeNull();
});

test("tokenExpired drops only a readable exp that has passed", () => {
	const now = Math.floor(Date.now() / 1000);
	expect(tokenExpired(jwt({ exp: now - 1 }))).toBe(true);
	expect(tokenExpired(jwt({ exp: now + 60 }))).toBe(false);
	// Without a readable `exp` the server decides, so the client keeps the token.
	expect(tokenExpired(jwt({ sub: "a" }))).toBe(false);
	expect(tokenExpired("not-a-jwt")).toBe(false);
});

describe("session token", () => {
	test("stores, reads, and clears the token", () => {
		expect(getSessionToken()).toBeNull();
		const token = jwt({ exp: Math.floor(Date.now() / 1000) + 60 });
		setSessionToken(token);
		expect(getSessionToken()).toBe(token);
		expect(sessionStorage.getItem(KEY)).toBe(token);
		setSessionToken(null);
		expect(getSessionToken()).toBeNull();
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	test("drops an expired token from storage", () => {
		sessionStorage.setItem(KEY, jwt({ exp: 1 }));
		expect(getSessionToken()).toBeNull();
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	test("tells each listener about every change until it unsubscribes", () => {
		const seen: string[] = [];
		const stopA = onSessionChange(() => seen.push(`a:${getSessionToken()}`));
		const stopB = onSessionChange(() => seen.push(`b:${getSessionToken()}`));
		setSessionToken("t1");
		stopA();
		setSessionToken(null);
		stopB();
		setSessionToken("t2");
		expect(seen).toEqual(["a:t1", "b:t1", "b:null"]);
	});

	test("without sessionStorage (prerender) there is no token and changes still notify", () => {
		const real = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
		if (real === undefined) throw new Error("setupDom provides sessionStorage");
		Object.defineProperty(globalThis, "sessionStorage", {
			value: undefined,
			configurable: true,
		});
		try {
			let changes = 0;
			const stop = onSessionChange(() => changes++);
			setSessionToken("t1");
			expect(getSessionToken()).toBeNull();
			setSessionToken(null);
			stop();
			expect(changes).toBe(2);
		} finally {
			Object.defineProperty(globalThis, "sessionStorage", real);
		}
	});
});
