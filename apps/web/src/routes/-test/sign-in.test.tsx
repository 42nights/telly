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

const pending = (returnTo = "/trip") =>
	sessionStorage.setItem(
		PENDING,
		JSON.stringify({
			verifier: "v".repeat(43),
			state: "s-1",
			nonce: "n-1",
			returnTo,
		}),
	);

// The exchange answers after the router's first load, as a real network does; an instant answer
// navigates before the initial /sign-in load ends, and that load wins.
const later = (body: unknown) => async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
	return body;
};

const saved = () => JSON.parse(sessionStorage.getItem(PENDING) ?? "{}");

test("Continue starts the issuer redirect, returning to the ?redirect page", async () => {
	serve({
		[DISCOVERY]: { authorization_endpoint: "https://issuer.test/auth" },
	});
	renderRoute("/sign-in?redirect=/trip");
	expect(
		await screen.findByRole("heading", {
			name: "Sign in or create an account",
		}),
	).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
	expect(
		screen
			.getByRole("button", { name: "Signing in…" })
			.hasAttribute("disabled"),
	).toBe(true);
	await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
	const url = new URL(String(assign.mock.calls[0]?.[0]));
	expect(url.searchParams.get("client_id")).toBe("web-client");
	expect(url.searchParams.get("redirect_uri")).toBe("http://app.test/sign-in");
	expect(saved().returnTo).toBe("/trip");
});

// #254: the start screen `/` opens this device's view home.
test("an unsafe ?redirect returns to the start screen after sign-in", async () => {
	serve({
		[DISCOVERY]: { authorization_endpoint: "https://issuer.test/auth" },
	});
	renderRoute("/sign-in?redirect=//evil.test");
	fireEvent.click(
		await screen.findByRole("button", { name: "Continue with Google" }),
	);
	await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
	expect(saved().returnTo).toBe("/");
});

test("a failed start shows the error and offers Try again", async () => {
	serve({
		[DISCOVERY]: () => {
			throw new TypeError("Failed to fetch");
		},
	});
	renderRoute("/sign-in");
	fireEvent.click(
		await screen.findByRole("button", { name: "Continue with Google" }),
	);
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Could not sign in. Failed to fetch",
	);
	expect(
		screen.getByRole("button", { name: "Try again with Google" }),
	).toBeTruthy();
	expect(assign).not.toHaveBeenCalled();
});

test("a matching callback exchanges the code and opens the saved page", async () => {
	pending("/trip");
	const token = signedInToken({ nonce: "n-1" });
	const calls = serve({
		"POST /api/sign-in/token": later({ idToken: token }),
		"GET /api/families": { families: [FAMILY] },
	});
	const { router } = renderRoute("/sign-in?code=c-1&state=s-1");
	await waitFor(() => expect(router.state.location.pathname).toBe("/trip"));
	expect(calls.find((c) => c.method === "POST")?.body).toEqual({
		code: "c-1",
		codeVerifier: "v".repeat(43),
		redirectUri: "http://app.test/sign-in",
	});
	expect(calls.some((c) => c.path === "/api/families")).toBe(true);
	expect(getSessionToken()).toBe(token);
});

// #245: a person with no family starts onboarding.
test("a first sign-in with no family opens onboarding", async () => {
	pending("/trip");
	serve({
		"POST /api/sign-in/token": later({
			idToken: signedInToken({ nonce: "n-1" }),
		}),
		"GET /api/families": { families: [] },
	});
	const { router } = renderRoute("/sign-in?code=c-1&state=s-1");
	await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
});

test("a member signing in is never sent to onboarding, even when it was the saved page", async () => {
	pending("/welcome");
	serve({
		"POST /api/sign-in/token": later({
			idToken: signedInToken({ nonce: "n-1" }),
		}),
		"GET /api/families": { families: [FAMILY] },
	});
	const { router } = renderRoute("/sign-in?code=c-1&state=s-1");
	await waitFor(() => expect(router.state.location.pathname).toBe("/hud"));
});

test("a callback from another tab is refused without calling the server", async () => {
	const calls = serve({});
	const { router } = renderRoute("/sign-in?code=c-1&state=s-1");
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Could not sign in. This sign-in reply is not from this tab. Sign in again.",
	);
	expect(router.state.location.search).toEqual({});
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

test("a signed-in visitor goes to the ?redirect page", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	const { router } = renderRoute("/sign-in?redirect=/trip");
	await waitFor(() => expect(router.state.location.pathname).toBe("/trip"));
});

test("a signed-in visitor with an unsafe ?redirect goes to the view home (Family)", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	const { router } = renderRoute("/sign-in?redirect=https://evil.test");
	await waitFor(() => expect(router.state.location.pathname).toBe("/family"));
});
