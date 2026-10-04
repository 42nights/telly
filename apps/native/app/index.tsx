import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

type Session = { readonly url: string; readonly token: string };

const KEY = "telly.session";

const fromLink = (link: string | null): Session | null => {
	if (link === null) return null;
	const { hostname, queryParams } = Linking.parse(link);
	const url = queryParams?.url;
	const token = queryParams?.token;
	return hostname === "signin" &&
		typeof url === "string" &&
		url.startsWith("https://") &&
		typeof token === "string"
		? { url, token }
		: null;
};

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
	const link = Linking.useURL();
	const [session, setSession] = useState<Session | null | undefined>();

	useEffect(() => {
		void SecureStore.getItemAsync(KEY).then((saved) =>
			setSession((current) =>
				current === undefined
					? saved === null
						? null
						: (JSON.parse(saved) as Session)
					: current,
			),
		);
	}, []);

	useEffect(() => {
		const next = fromLink(link);
		if (next === null) return;
		void SecureStore.setItemAsync(KEY, JSON.stringify(next));
		setSession(next);
	}, [link]);

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
