// The phone's signed-in session (issue #4): the OIDC ID token that the sign-in screen stores. It
// lives only in Expo SecureStore (iOS Keychain, Android Keystore), never in AsyncStorage or logs.
// The server checks the signature, issuer, audience, and expiry; the app only drops a passed `exp`.
import { tokenExpired } from "@health/contracts/session";
import * as SecureStore from "expo-secure-store";

const KEY = "telly.session.token";

export const readSessionToken = async (): Promise<string | null> => {
	const token = await SecureStore.getItemAsync(KEY);
	if (token === null || !tokenExpired(token)) return token;
	await SecureStore.deleteItemAsync(KEY);
	return null;
};

export const writeSessionToken = (token: string | null) =>
	token === null
		? SecureStore.deleteItemAsync(KEY)
		: SecureStore.setItemAsync(KEY, token, {
				keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
			});
