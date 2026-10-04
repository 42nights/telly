import * as SecureStore from "expo-secure-store";

export type WebSession = { readonly url: string; readonly token: string };

const KEY = "telly.web.session";

export const loadWebSession = async (): Promise<WebSession | null> => {
	const saved = await SecureStore.getItemAsync(KEY);
	return saved === null ? null : (JSON.parse(saved) as WebSession);
};

export const saveWebSession = (session: WebSession) =>
	SecureStore.setItemAsync(KEY, JSON.stringify(session));
