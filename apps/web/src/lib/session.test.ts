import { afterEach, describe, expect, test } from "bun:test";
import { tokenClaims, tokenExpired } from "@health/contracts/session";
import {
	type AnyRouter,
	isRedirect,
	type ParsedLocation,
} from "@tanstack/react-router";

import { setupDom } from "@/lib/test/dom";

import {
	followSession,
	getSessionToken,
	onSessionChange,
	requireSession,
	returnPath,
	setSessionToken,
} from "./session";

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

describe("sign-in gate", () => {
	const signIn = () =>
		setSessionToken(
			`h.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url")}.s`,
		);

	// The guard as the root route runs it, for the address the visitor opened.
	const open = (href: string) => {
		const location = {
			href,
			pathname: new URL(href, "http://app.test").pathname,
			searchStr: new URL(href, "http://app.test").search,
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

	test("signed out, a finder link opens the medicine page; other pages still need sign-in", () => {
		expect(open("/medicine?person=7&link=t")).toBe("page");
		expect(open("/medicine?person=7")).toMatchObject(
			toSignIn("/medicine?person=7"),
		);
		expect(open("/family?link=t")).toMatchObject(toSignIn("/family?link=t"));
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
			expect(returnPath(unsafe)).toBe("/");
	});
});
