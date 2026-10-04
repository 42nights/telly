// The signed-in session the web app sends to the server: the OIDC ID token that the sign-in screen
// (issue #4) stores with `setSessionToken`. Without a token, or after its `exp`, every protected
// read shows "sign-in required" instead of data.
import { tokenExpired } from "@health/contracts/session";

const KEY = "telly.session.token";
const listeners = new Set<() => void>();

const storage = (): Storage | undefined =>
	typeof sessionStorage === "undefined" ? undefined : sessionStorage;

export const getSessionToken = (): string | null => {
	const token = storage()?.getItem(KEY) ?? null;
	if (token === null || !tokenExpired(token)) return token;
	storage()?.removeItem(KEY);
	return null;
};

export const setSessionToken = (token: string | null) => {
	if (token === null) storage()?.removeItem(KEY);
	else storage()?.setItem(KEY, token);
	for (const listener of listeners) listener();
};

export const onSessionChange = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
