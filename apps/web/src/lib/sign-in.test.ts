import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `dom` must register `document` and mock `@/env` before these modules load.
const { json, serve, signedInToken } = await import("@/lib/test/app");
const { finishSignIn, signInConfig, startSignIn } = await import(
	"@/lib/sign-in"
);
const { getSessionToken } = await import("@/lib/session");

const CONFIG = { issuer: "https://issuer.test/", clientId: "web-client" };
const PENDING = "telly.sign-in.pending";

const assign = spyOn(location, "assign").mockImplementation(() => {});
afterEach(() => assign.mockClear());

const pending = (state = "s-1", nonce = "n-1") =>
	sessionStorage.setItem(
		PENDING,
		JSON.stringify({ verifier: "v".repeat(43), state, nonce }),
	);

test("signInConfig reads the issuer and client id", () => {
	expect(signInConfig()).toEqual({
		issuer: "https://issuer.test",
		clientId: "web-client",
	});
});

test("startSignIn reads discovery, saves PKCE state, and redirects to the issuer", async () => {
	const calls = serve({
		"GET /.well-known/openid-configuration": {
			authorization_endpoint: "https://issuer.test/auth",
		},
	});
	await startSignIn(CONFIG);
	expect(calls.map((c) => c.path)).toEqual([
		"/.well-known/openid-configuration",
	]);
	const saved = JSON.parse(sessionStorage.getItem(PENDING) ?? "{}");
	const url = new URL(String(assign.mock.calls[0]?.[0]));
	expect(url.origin + url.pathname).toBe("https://issuer.test/auth");
	expect(url.searchParams.get("client_id")).toBe("web-client");
	expect(url.searchParams.get("redirect_uri")).toBe("http://app.test/sign-in");
	expect(url.searchParams.get("state")).toBe(saved.state);
	expect(url.searchParams.get("nonce")).toBe(saved.nonce);
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(saved.verifier),
		),
	);
	expect(url.searchParams.get("code_challenge")).toBe(
		Buffer.from(digest).toString("base64url"),
	);
	expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("startSignIn fails on a discovery HTTP error without redirecting", async () => {
	serve({ "GET /.well-known/openid-configuration": json(503, {}) });
	await expect(startSignIn(CONFIG)).rejects.toThrow(
		"The sign-in server replied HTTP 503.",
	);
	expect(assign).not.toHaveBeenCalled();
	expect(sessionStorage.getItem(PENDING)).toBeNull();
});

test("startSignIn rejects a malformed discovery document", async () => {
	serve({ "GET /.well-known/openid-configuration": { issuer: "x" } });
	await expect(startSignIn(CONFIG)).rejects.toThrow();
	expect(assign).not.toHaveBeenCalled();
});

test("finishSignIn exchanges the code and stores the matching token", async () => {
	pending();
	const token = signedInToken({ iss: CONFIG.issuer, nonce: "n-1" });
	const calls = serve({ "POST /api/sign-in/token": { idToken: token } });
	await finishSignIn(CONFIG, { code: "c-1", state: "s-1" });
	expect(calls[0]?.body).toEqual({
		code: "c-1",
		codeVerifier: "v".repeat(43),
		redirectUri: "http://app.test/sign-in",
	});
	expect(getSessionToken()).toBe(token);
	expect(sessionStorage.getItem(PENDING)).toBeNull();
});

test("finishSignIn rejects a reply with no, bad, or other-tab pending state", async () => {
	const calls = serve({});
	const message = "This sign-in reply is not from this tab. Sign in again.";
	await expect(
		finishSignIn(CONFIG, { code: "c", state: "s-1" }),
	).rejects.toThrow(message);
	sessionStorage.setItem(PENDING, "not json");
	await expect(
		finishSignIn(CONFIG, { code: "c", state: "s-1" }),
	).rejects.toThrow(message);
	pending("other");
	await expect(
		finishSignIn(CONFIG, { code: "c", state: "s-1" }),
	).rejects.toThrow(message);
	expect(calls).toEqual([]);
});

test("finishSignIn rejects a token with the wrong nonce or issuer", async () => {
	for (const claims of [
		{ iss: CONFIG.issuer, nonce: "other" },
		{ iss: "https://evil.test", nonce: "n-1" },
	]) {
		pending();
		serve({ "POST /api/sign-in/token": { idToken: signedInToken(claims) } });
		await expect(
			finishSignIn(CONFIG, { code: "c", state: "s-1" }),
		).rejects.toThrow("The sign-in server sent a token for another sign-in.");
	}
	expect(getSessionToken()).toBeNull();
});

test("signInConfig is null when the OIDC settings are missing", () => {
	mock.module("@/env", () => ({
		ENV: { VITE_SERVER_URL: "http://server.test" },
	}));
	expect(signInConfig()).toBeNull();
	mock.module("@/env", () => ({
		ENV: {
			VITE_SERVER_URL: "http://server.test",
			VITE_OIDC_ISSUER: "https://issuer.test",
			VITE_OIDC_CLIENT_ID: "web-client",
		},
	}));
});
