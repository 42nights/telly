// The signed-in session the web app sends to the server: the OIDC ID token and the refresh token that
// the sign-in screen (issue #4) stores with `setSessionToken`. The ID token lasts one hour;
// `freshSessionToken` renews it through the server before each request (issue #222). Without a
// token, or after its `exp` with no refresh token, every app page shows the sign-in screen instead
// (`requireSession`), except a finder link.
import {
	refreshSignIn,
	SESSION_KEYS,
	tokenExpired,
} from "@health/contracts/session";
import {
	type AnyRouter,
	type ParsedLocation,
	redirect,
} from "@tanstack/react-router";

import { ENV } from "@/env";

const RENEW_BEFORE_MS = 5 * 60_000;
const SIGN_IN = "/sign-in";
const listeners = new Set<() => void>();

const storage = (): Storage | undefined =>
	typeof sessionStorage === "undefined" ? undefined : sessionStorage;

/**
 * The stored ID token, or `null` when signed out. While a refresh token is kept, an expired ID
 * token still counts as signed in: `freshSessionToken` renews it before it is sent.
 */
export const getSessionToken = (): string | null => {
	const token = storage()?.getItem(SESSION_KEYS.idToken) ?? null;
	if (
		token === null ||
		!tokenExpired(token) ||
		storage()?.getItem(SESSION_KEYS.refreshToken)
	)
		return token;
	storage()?.removeItem(SESSION_KEYS.idToken);
	return null;
};

// Inside the iOS shell (`apps/native`), sign-out also clears the session that the phone keeps.
declare global {
	var ReactNativeWebView:
		| { readonly postMessage: (data: string) => void }
		| undefined;
}

/** Starts a session (`token`, with its refresh token when the issuer sent one) or ends it (`null`). */
export const setSessionToken = (
	token: string | null,
	refreshToken?: string,
) => {
	storage()?.removeItem(SESSION_KEYS.refreshToken);
	if (token === null) {
		storage()?.removeItem(SESSION_KEYS.idToken);
		globalThis.ReactNativeWebView?.postMessage(
			JSON.stringify({ type: "sign-out" }),
		);
	} else {
		storage()?.setItem(SESSION_KEYS.idToken, token);
		if (refreshToken !== undefined)
			storage()?.setItem(SESSION_KEYS.refreshToken, refreshToken);
	}
	for (const listener of listeners) listener();
};

let renewal: Promise<string | null> | undefined;

/**
 * The ID token to send now: renewed first when it expires within five minutes. A refused refresh
 * token ends the session. When the server cannot be reached, the current token is sent and the next
 * request tries again.
 */
export const freshSessionToken = async (): Promise<string | null> => {
	const token = getSessionToken();
	const refreshToken = storage()?.getItem(SESSION_KEYS.refreshToken);
	if (token === null || !refreshToken || !tokenExpired(token, RENEW_BEFORE_MS))
		return token;
	renewal ??= refreshSignIn(ENV.VITE_SERVER_URL, refreshToken)
		.then((renewed) => {
			// Only the ID token changes, so the session listeners need not run.
			if (renewed === null) setSessionToken(null);
			else storage()?.setItem(SESSION_KEYS.idToken, renewed);
			return renewed;
		})
		.catch((error: unknown) => {
			console.warn("Could not renew the session", error);
			return token;
		})
		.finally(() => {
			renewal = undefined;
		});
	return renewal;
};

export const onSessionChange = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** The app page to open after sign-in: `path` when it is a page of this app, otherwise the start screen. */
export const returnPath = (path: string | undefined): string =>
	path !== undefined && /^\/(?![/\\])/.test(path) && !path.startsWith(SIGN_IN)
		? path
		: "/";

/** A finder link (#308): `/medicine?link=<token>` opens without sign-in, and the server checks the token. */
const isFinderLink = (location: ParsedLocation) =>
	location.pathname === "/medicine" &&
	new URLSearchParams(location.searchStr).has("link");

/**
 * Root `beforeLoad`: with no session, every page except sign-in and a finder link goes to sign-in,
 * which returns here.
 */
export const requireSession = ({ location }: { location: ParsedLocation }) => {
	if (
		location.pathname === SIGN_IN ||
		getSessionToken() !== null ||
		isFinderLink(location)
	)
		return;
	throw redirect({
		to: SIGN_IN,
		search: { redirect: location.href },
		replace: true,
	});
};

/**
 * Runs `requireSession` again when the session starts or ends, and every 30 s, so a sign-out, a
 * rejected token, or a token that expires while the app is open shows the sign-in screen.
 */
export const followSession = (router: AnyRouter) => {
	let signedIn = getSessionToken() !== null;
	const check = () => {
		const now = getSessionToken() !== null;
		if (now === signedIn) return;
		signedIn = now;
		void router.invalidate();
	};
	const stop = onSessionChange(check);
	const timer = setInterval(check, 30_000);
	return () => {
		stop();
		clearInterval(timer);
	};
};
