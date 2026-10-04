// The phone's signed-in session (issues #4 and #222): the OIDC ID token and the refresh token that the
// sign-in screen stores. They live only in Expo SecureStore (iOS Keychain, Android Keystore), never in
// AsyncStorage or logs. The server checks the ID token's signature, issuer, audience, and expiry; the
// app renews the one-hour ID token with the refresh token, and drops a session the issuer refuses.
import {
	refreshSignIn,
	type SignInToken,
	tokenExpired,
} from "@health/contracts/session";
import * as SecureStore from "expo-secure-store";

import { ENV } from "@/src/env";

const ID_KEY = "telly.session.token";
const REFRESH_KEY = "telly.session.refresh";
const RENEW_BEFORE_MS = 5 * 60_000;
const keychain = {
	keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Stores a new session, or deletes it (`null`). */
export const writeSession = async (session: SignInToken | null) => {
	if (session === null) {
		await SecureStore.deleteItemAsync(ID_KEY);
		await SecureStore.deleteItemAsync(REFRESH_KEY);
		return;
	}
	await SecureStore.setItemAsync(ID_KEY, session.idToken, keychain);
	if (session.refreshToken === undefined)
		await SecureStore.deleteItemAsync(REFRESH_KEY);
	else
		await SecureStore.setItemAsync(REFRESH_KEY, session.refreshToken, keychain);
};

/**
 * The stored session, with its ID token renewed first when it expires within five minutes, or
 * `null` when signed out. When the server cannot be reached, the stored session is returned and the
 * next read tries again.
 */
export const readSession = async (): Promise<SignInToken | null> => {
	const idToken = await SecureStore.getItemAsync(ID_KEY);
	if (idToken === null) return null;
	const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
	if (refreshToken === null) {
		if (!tokenExpired(idToken)) return { idToken };
		await writeSession(null);
		return null;
	}
	if (!tokenExpired(idToken, RENEW_BEFORE_MS)) return { idToken, refreshToken };
	try {
		const renewed = await refreshSignIn(
			ENV.EXPO_PUBLIC_SERVER_URL,
			refreshToken,
		);
		if (renewed === null) {
			await writeSession(null);
			return null;
		}
		await SecureStore.setItemAsync(ID_KEY, renewed, keychain);
		return { idToken: renewed, refreshToken };
	} catch (error) {
		console.warn("Could not renew the session", error);
		return { idToken, refreshToken };
	}
};
