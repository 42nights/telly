import * as SecureStore from "expo-secure-store";

export type Session = { readonly url: string; readonly token: string };

const KEY = "telly.session";

export const loadSession = async (): Promise<Session | null> => {
	const saved = await SecureStore.getItemAsync(KEY);
	return saved === null ? null : (JSON.parse(saved) as Session);
};

export const saveSession = (session: Session) =>
	SecureStore.setItemAsync(KEY, JSON.stringify(session));
