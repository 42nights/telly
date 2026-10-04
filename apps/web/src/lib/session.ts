// The signed-in session the web app sends to the server: the OIDC ID token that the sign-in screen
// (issue #4) stores with `setSessionToken`. Without a token, or after its `exp`, every app page
// shows the sign-in screen instead (`requireSession`).
import { tokenExpired } from "@health/contracts/session";
import {
	type AnyRouter,
	type ParsedLocation,
	redirect,
} from "@tanstack/react-router";

const KEY = "telly.session.token";
const SIGN_IN = "/sign-in";
const listeners = new Set<() => void>();

const storage = (): Storage | undefined =>
	typeof sessionStorage === "undefined" ? undefined : sessionStorage;

export const getSessionToken = (): string | null => {
	const token = storage()?.getItem(KEY) ?? null;
	if (token === null || !tokenExpired(token)) return token;
	storage()?.removeItem(KEY);
	return null;
};

// Inside the iOS shell (`apps/native`), sign-out also clears the session that the phone keeps.
declare global {
	var ReactNativeWebView:
		| { readonly postMessage: (data: string) => void }
		| undefined;
}

export const setSessionToken = (token: string | null) => {
	if (token === null) {
		storage()?.removeItem(KEY);
		globalThis.ReactNativeWebView?.postMessage(
			JSON.stringify({ type: "sign-out" }),
		);
	} else storage()?.setItem(KEY, token);
	for (const listener of listeners) listener();
};

export const onSessionChange = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** The app page to open after sign-in: `path` when it is a page of this app, otherwise Home. */
export const returnPath = (path: string | undefined): string =>
	path !== undefined && /^\/(?![/\\])/.test(path) && !path.startsWith(SIGN_IN)
		? path
		: "/hud";

/** Root `beforeLoad`: with no session, every page except sign-in goes to sign-in, which returns here. */
export const requireSession = ({ location }: { location: ParsedLocation }) => {
	if (location.pathname === SIGN_IN || getSessionToken() !== null) return;
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
