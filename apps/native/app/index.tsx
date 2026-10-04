import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { loadSession, type Session } from "@/lib/session";

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

export default function Home() {
	const [session, setSession] = useState<Session | null | undefined>();

	useFocusEffect(
		useCallback(() => {
			void loadSession().then(setSession);
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
		<SafeAreaView style={styles.fill} edges={["top"]}>
			<WebView
				key={session.url}
				source={{ uri: session.url }}
				injectedJavaScriptBeforeContentLoaded={`sessionStorage.setItem("telly.session.token", ${JSON.stringify(session.token)}); true;`}
				mediaCapturePermissionGrantType="grant"
				allowsInlineMediaPlayback
				style={styles.fill}
			/>
		</SafeAreaView>
	);
}
