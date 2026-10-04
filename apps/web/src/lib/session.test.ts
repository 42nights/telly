import { afterEach, describe, expect, test } from "bun:test";

import { tokenClaims, tokenExpired } from "@health/contracts/session";
import {
	type AnyRouter,
	isRedirect,
	type ParsedLocation,
} from "@tanstack/react-router";

import {
	followSession,
	requireSession,
	returnPath,
	setSessionToken,
} from "./session";

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

describe("sign-in gate", () => {
	// Bun has no sessionStorage; the session module reads it lazily.
	const items = new Map<string, string>();
	globalThis.sessionStorage = {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	} as Storage;
	const signIn = () =>
		setSessionToken(
			`h.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url")}.s`,
		);

	// The guard as the root route runs it, for the address the visitor opened.
	const open = (href: string) => {
		const location = {
			href,
			pathname: new URL(href, "http://app.test").pathname,
		} as ParsedLocation;
		try {
			requireSession({ location });
			return "page";
		} catch (thrown) {
			if (!isRedirect(thrown)) throw thrown;
			return thrown.options;
		}
	};
	const toSignIn = (redirect: string) => ({
		to: "/sign-in",
		search: { redirect },
		replace: true,
	});

	afterEach(() => setSessionToken(null));

	test("signed out, every deep link shows sign-in and remembers the page", () => {
		expect(open("/medicine?day=today")).toMatchObject(
			toSignIn("/medicine?day=today"),
		);
		expect(open("/family")).toMatchObject(toSignIn("/family"));
		expect(open("/")).toMatchObject(toSignIn("/"));
		// The sign-in screen and the issuer's return to it stay open.
		expect(open("/sign-in?code=c&state=s")).toBe("page");
	});

	test("signed in, the page opens", () => {
		signIn();
		expect(open("/medicine")).toBe("page");
	});

	test("an expired token counts as signed out", () => {
		setSessionToken(
			`h.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 - 1 })).toString("base64url")}.s`,
		);
		expect(open("/care")).toMatchObject(toSignIn("/care"));
	});

	test("signing out runs the gate again, so the page shows sign-in", () => {
		signIn();
		let checks = 0;
		const stop = followSession({
			invalidate: async () => {
				checks++;
			},
		} as unknown as AnyRouter);
		signIn();
		expect(checks).toBe(0);
		setSessionToken(null);
		stop();
		expect(checks).toBe(1);
		expect(open("/family")).toMatchObject(toSignIn("/family"));
	});

	test("sign-in returns only to a page of this app", () => {
		expect(returnPath("/trip?leg=2")).toBe("/trip?leg=2");
		for (const unsafe of [
			undefined,
			"https://evil.test/",
			"//evil.test/",
			"/\\evil.test/",
			"/sign-in?redirect=/hud",
		])
			expect(returnPath(unsafe)).toBe("/hud");
	});
});
