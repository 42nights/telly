// The iOS shell (issue #94): the web app full screen in a WebView. Only the web app's origin loads
// here. The issuer's sign-in page starts the native sign-in instead (Google refuses sign-in in a
// WebView). Other sites open in Safari, and `tel:` and `mailto:` links open the phone and mail apps.
import { Schema } from "effect";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Linking, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

import { originOf } from "@/lib/origin";
import { readSessionToken, writeSessionToken } from "@/lib/session";
import { issuer, signIn } from "@/lib/sign-in";
import { ENV } from "@/src/env";

const WEB_ORIGIN = originOf(ENV.EXPO_PUBLIC_WEB_URL);
const ISSUER_ORIGIN = issuer ? originOf(issuer) : null;

// The JS bridge: the web app calls `window.ReactNativeWebView.postMessage(JSON.stringify(message))`
// (a WKScriptMessageHandler on iOS). Add a member here for each native feature, such as glasses audio.
const BridgeMessage = Schema.Struct({ type: Schema.Literals(["sign-out"]) });

const decodeBridgeMessage = (data: string) => {
	try {
		return Schema.decodeUnknownSync(BridgeMessage)(JSON.parse(data));
	} catch {
		return null;
	}
};

const styles = StyleSheet.create({ fill: { flex: 1 } });

export default function WebApp() {
	// `undefined` until SecureStore answers. `readSessionToken` drops an expired token.
	const [token, setToken] = useState<string | null>();
	const [signingIn, setSigningIn] = useState(false);

	useFocusEffect(
		useCallback(() => {
			void readSessionToken().then(setToken);
		}, []),
	);

	const startSignIn = () => {
		if (signingIn) return;
		setSigningIn(true);
		signIn()
			.then(async (idToken) => {
				if (idToken === null) return;
				await writeSessionToken(idToken);
				setToken(idToken);
			})
			.catch((error: unknown) =>
				Alert.alert(
					"Could not sign in",
					error instanceof Error ? error.message : String(error),
				),
			)
			.finally(() => setSigningIn(false));
	};

	if (token === undefined || WEB_ORIGIN === null) return null;
	return (
		<WebView
			// A new token reloads the page, so the web app always starts with the stored session.
			key={token ?? "signed-out"}
			source={{ uri: ENV.EXPO_PUBLIC_WEB_URL }}
			// The token goes only into the web app's own origin, in the main frame.
			injectedJavaScriptBeforeContentLoaded={`if (location.origin === ${JSON.stringify(WEB_ORIGIN)}) { ${
				token === null
					? `sessionStorage.removeItem("telly.session.token");`
					: `sessionStorage.setItem("telly.session.token", ${JSON.stringify(token)});`
			} } true;`}
			// Every URL reaches the check below; the library default opens other schemes itself.
			originWhitelist={["*"]}
			onShouldStartLoadWithRequest={({ url, isTopFrame }) => {
				const origin = originOf(url);
				if (origin === WEB_ORIGIN) return true;
				// Frames inside the web app get no token, and camera and microphone ask first.
				if (!isTopFrame && (origin !== null || url.startsWith("about:")))
					return true;
				if (origin !== null && origin === ISSUER_ORIGIN) startSignIn();
				else
					void Linking.openURL(url).catch((error: unknown) =>
						console.warn("Could not open the link", error),
					);
				return false;
			}}
			onMessage={({ nativeEvent }) => {
				if (originOf(nativeEvent.url) !== WEB_ORIGIN) return;
				const message = decodeBridgeMessage(nativeEvent.data);
				if (message?.type === "sign-out")
					void writeSessionToken(null).then(() => setToken(null));
			}}
			mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
			allowsInlineMediaPlayback
			style={styles.fill}
		/>
	);
}
