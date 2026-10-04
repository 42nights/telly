import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import { loadWebSession, type WebSession } from "@/lib/web-session";

const styles = StyleSheet.create({
	fill: { flex: 1 },
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		padding: 24,
	},
	text: { fontSize: 17, textAlign: "center" },
});

export default function WebApp() {
	const [session, setSession] = useState<WebSession | null | undefined>();

	useFocusEffect(
		useCallback(() => {
			void loadWebSession().then(setSession);
		}, []),
	);

	if (session === undefined) return null;
	if (session === null)
		return (
			<View style={styles.center}>
				<Text style={styles.text}>
					Open the sign-in link from the Mac to connect this phone.
				</Text>
			</View>
		);
	return (
		<WebView
			key={session.url}
			source={{ uri: session.url }}
			injectedJavaScriptBeforeContentLoaded={`sessionStorage.setItem("telly.session.token", ${JSON.stringify(session.token)}); true;`}
			mediaCapturePermissionGrantType="grant"
			allowsInlineMediaPlayback
			style={styles.fill}
		/>
	);
}
