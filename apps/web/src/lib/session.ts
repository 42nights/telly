// The signed-in session the web app sends to the server: the OIDC ID token that the sign-in screen
// (issue #4) stores with `setSessionToken`. Without a token, or after its `exp`, every protected
// read shows "sign-in required" instead of data.
import { Schema } from "effect";

const KEY = "telly.session.token";
const listeners = new Set<() => void>();

const storage = (): Storage | undefined =>
	typeof sessionStorage === "undefined" ? undefined : sessionStorage;

/** The JWT payload of `token`, not verified (the server checks the signature). */
export const tokenClaims = (token: string): unknown => {
	try {
		const payload = (token.split(".")[1] ?? "")
			.replace(/-/g, "+")
			.replace(/_/g, "/");
		const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
};

const decodeExp = Schema.decodeUnknownOption(
	Schema.Struct({ exp: Schema.Number }),
);

export const getSessionToken = (): string | null => {
	const token = storage()?.getItem(KEY) ?? null;
	if (token === null) return null;
	const claims = decodeExp(tokenClaims(token));
	// No readable `exp`: the server decides. A passed `exp` means signed out.
	if (claims._tag === "None" || claims.value.exp * 1000 > Date.now())
		return token;
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
