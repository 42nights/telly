import { afterEach, expect, spyOn, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before these modules load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn, signedInToken } =
	await import("@/lib/test/app");
const { getSessionToken } = await import("@/lib/session");

const PENDING = "telly.sign-in.pending";
const DISCOVERY = "GET /.well-known/openid-configuration";

const assign = spyOn(location, "assign").mockImplementation(() => {});
afterEach(() => assign.mockClear());

const pending = () =>
	sessionStorage.setItem(
		PENDING,
		JSON.stringify({ verifier: "v".repeat(43), state: "s-1", nonce: "n-1" }),
	);

test("Sign in starts the issuer redirect and shows progress", async () => {
	serve({
		"GET /api/families": { families: [FAMILY] },
		[DISCOVERY]: { authorization_endpoint: "https://issuer.test/auth" },
	});
	renderRoute("/sign-in");
	fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
	expect(
		screen
			.getByRole("button", { name: "Signing in…" })
			.hasAttribute("disabled"),
	).toBe(true);
	await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
	const url = new URL(String(assign.mock.calls[0]?.[0]));
	expect(url.searchParams.get("client_id")).toBe("web-client");
	expect(url.searchParams.get("redirect_uri")).toBe("http://app.test/sign-in");
});

test("a failed start shows the error and offers Try again", async () => {
	serve({
		[DISCOVERY]: () => {
			throw new TypeError("Failed to fetch");
		},
	});
	renderRoute("/sign-in");
	fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Could not sign in. Failed to fetch",
	);
	expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	expect(assign).not.toHaveBeenCalled();
});

test("a matching callback exchanges the code, clears the address, and signs in", async () => {
	pending();
	const token = signedInToken({ nonce: "n-1" });
	const calls = serve({ "POST /api/sign-in/token": { idToken: token } });
	const { router } = renderRoute("/sign-in?code=c-1&state=s-1");
	expect(await screen.findByText("You are signed in.")).toBeTruthy();
	expect(screen.getByRole("link", { name: "Go to Family" })).toBeTruthy();
	expect(router.state.location.search).toEqual({});
	expect(calls.find((c) => c.method === "POST")?.body).toEqual({
		code: "c-1",
		codeVerifier: "v".repeat(43),
		redirectUri: "http://app.test/sign-in",
	});
	expect(getSessionToken()).toBe(token);
});

test("a callback from another tab is refused without calling the server", async () => {
	const calls = serve({});
	renderRoute("/sign-in?code=c-1&state=s-1");
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Could not sign in. This sign-in reply is not from this tab. Sign in again.",
	);
	expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("the server's exchange failure message is shown", async () => {
	pending();
	serve({
		"POST /api/sign-in/token": json(503, {
			error: "unavailable",
			message: "Sign-in is down.",
		}),
	});
	renderRoute("/sign-in?code=c-1&state=s-1");
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Could not sign in. Sign-in is down.",
	);
	expect(getSessionToken()).toBeNull();
});

test("an issuer error parameter is shown", async () => {
	serve({});
	renderRoute("/sign-in?error=access_denied");
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Could not sign in. The sign-in server said: access_denied",
	);
});

test("a signed-in visitor sees the signed-in state", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	renderRoute("/sign-in");
	expect(await screen.findByText("You are signed in.")).toBeTruthy();
});
