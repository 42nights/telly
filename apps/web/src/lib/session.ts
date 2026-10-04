// The signed-in session the web app sends to the server. Sign-in itself belongs to issue #4: its
// screen stores the OIDC token here with `setSessionToken`. Until then there is no token, and every
// protected read shows "sign-in required" instead of data.
const KEY = "telly.session.token";
const listeners = new Set<() => void>();

const storage = (): Storage | undefined =>
	typeof sessionStorage === "undefined" ? undefined : sessionStorage;

export const getSessionToken = (): string | null =>
	storage()?.getItem(KEY) ?? null;

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
