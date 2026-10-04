// The iOS shell (issues #94 and #347): the whole app is this one screen, the web app full screen
// in a WebView with safe-area padding and no native menu. Only the web app's origin loads here.
// The issuer's sign-in page starts the native sign-in instead (Google refuses sign-in in a WebView).
// Other sites open in Safari, and `tel:` and `mailto:` links open the phone and mail apps.
import { DbId } from "@health/contracts/families";
import { SESSION_KEYS, type SignInToken } from "@health/contracts/session";
import { Schema } from "effect";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Linking, Platform, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { ArRequest, answerArRequest } from "@/lib/ar-bridge";
import { setLocationWatch } from "@/lib/location-watch";
import { originOf } from "@/lib/origin";
import { readSession, writeSession } from "@/lib/session";
import { issuer, signIn } from "@/lib/sign-in";
import TellyAr from "@/modules/telly-ar";
import { ENV } from "@/src/env";

const WEB_ORIGIN = originOf(ENV.EXPO_PUBLIC_WEB_URL);
const ISSUER_ORIGIN = issuer ? originOf(issuer) : null;

// The JS bridge: the web app calls `window.ReactNativeWebView.postMessage(JSON.stringify(message))`
// (a WKScriptMessageHandler on iOS). Add a member here for each native feature, such as glasses audio.
// `location-watch` starts (a family id) or stops (`null`) background location for automatic trips.
// AR pin answers go back as `window.dispatchEvent(new CustomEvent("telly-ar", { detail }))`.
const BridgeMessage = Schema.Union([
	Schema.Struct({ type: Schema.Literals(["sign-out"]) }),
	Schema.Struct({
		type: Schema.Literal("location-watch"),
		familyId: Schema.NullOr(DbId),
	}),
	ArRequest,
]);

const decodeBridgeMessage = (data: string) => {
	try {
		return Schema.decodeUnknownSync(BridgeMessage)(JSON.parse(data));
	} catch {
		return null;
	}
};

// The web app's desktop teal (`--win95-desktop`, its theme-color) fills the safe-area padding.
const styles = StyleSheet.create({
	fill: { flex: 1 },
	frame: { flex: 1, backgroundColor: "#008080" },
});

export default function WebApp() {
	// `undefined` until SecureStore answers. `readSession` renews or drops an expired ID token.
	const [session, setSession] = useState<SignInToken | null>();
	const [signingIn, setSigningIn] = useState(false);
	const webView = useRef<WebView>(null);

	useFocusEffect(
		useCallback(() => {
			void readSession().then(setSession);
		}, []),
	);

	const startSignIn = () => {
		if (signingIn) return;
		setSigningIn(true);
		signIn()
			.then(async (signedIn) => {
				if (signedIn === null) return;
				await writeSession(signedIn);
				setSession(signedIn);
			})
			.catch((error: unknown) =>
				Alert.alert(
					"Could not sign in",
					error instanceof Error ? error.message : String(error),
				),
			)
			.finally(() => setSigningIn(false));
	};

	if (session === undefined || WEB_ORIGIN === null) return null;
	// The web app's session keys, written before the page loads. The web app renews the ID token
	// itself with the refresh token (`apps/web/src/lib/session.ts`).
	const storage = Object.entries({
		[SESSION_KEYS.idToken]: session?.idToken,
		[SESSION_KEYS.refreshToken]: session?.refreshToken,
	})
		.map(([key, value]) =>
			value === undefined
				? `sessionStorage.removeItem(${JSON.stringify(key)});`
				: `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`,
		)
		.join(" ");
	return (
		<SafeAreaView style={styles.frame}>
			<WebView
				ref={webView}
				// A new session reloads the page, so the web app always starts with the stored session.
				key={session?.idToken ?? "signed-out"}
				source={{ uri: ENV.EXPO_PUBLIC_WEB_URL }}
				// The session goes only into the web app's own origin, in the main frame.
				injectedJavaScriptBeforeContentLoaded={`if (location.origin === ${JSON.stringify(WEB_ORIGIN)}) { ${storage} } true;`}
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
					if (message === null) return;
					if (message.type === "location-watch") {
						void setLocationWatch(message.familyId).catch((error: unknown) =>
							console.warn("Could not change background location", error),
						);
						return;
					}
					if (message.type === "sign-out") {
						void Promise.all([setLocationWatch(null), writeSession(null)]).then(
							() => setSession(null),
						);
						return;
					}
					// The answer (a room scan for a saved pin) goes only to the web app's origin.
					void answerArRequest(message, TellyAr, Platform.OS).then((reply) =>
						webView.current?.injectJavaScript(
							`if (location.origin === ${JSON.stringify(WEB_ORIGIN)}) window.dispatchEvent(new CustomEvent("telly-ar", { detail: ${JSON.stringify(reply)} })); true;`,
						),
					);
				}}
				mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
				allowsInlineMediaPlayback
				style={styles.fill}
			/>
		</SafeAreaView>
	);
}
