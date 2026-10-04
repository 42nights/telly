import { type Loaded, loadDecoded, Sources } from "@health/contracts";
import { FamilyList } from "@health/contracts/families";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { readSession, writeSession } from "@/lib/session";
import { useColorScheme } from "@/lib/use-color-scheme";
import { ENV } from "@/src/env";

// `signed_out`: no stored token, so no protected read is sent.
type Families = Loaded<FamilyList> | { readonly kind: "signed_out" };
type Theme = (typeof NAV_THEME)["light"];

export default function Home() {
	const { colorScheme } = useColorScheme();
	const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;
	const text = { color: theme.text };
	const [state, setState] = useState<Loaded<Sources>>();

	useEffect(
		() =>
			loadDecoded(
				Sources,
				`${ENV.EXPO_PUBLIC_SERVER_URL}/api/sources`,
				setState,
			),
		[],
	);

	return (
		<Container>
			<ScrollView
				style={styles.scrollView}
				contentContainerStyle={styles.content}
				contentInsetAdjustmentBehavior="never"
			>
				<FamilyCard theme={theme} />
				<View
					style={[
						styles.card,
						{ backgroundColor: theme.card, borderColor: theme.border },
					]}
				>
					<Text style={[styles.title, text]}>Data sources</Text>
					{state === undefined && (
						<Text style={text}>Checking the server…</Text>
					)}
					{/* An unreachable server is unavailable, never "all clear". */}
					{state?.kind === "error" && (
						<Text accessibilityRole="alert" style={text}>
							Server unavailable: {state.message}
						</Text>
					)}
					{state?.kind === "ready" &&
						state.value.sources.map((source) => (
							<View key={source.source}>
								<Text style={[styles.title, text]}>NOOP not connected</Text>
								<Text style={text}>
									WHOOP readings and WHOOP-based nudges are unavailable.
								</Text>
							</View>
						))}
				</View>
			</ScrollView>
		</Container>
	);
}

/** The signed-in caller's families, read with the SecureStore token. */
function FamilyCard({ theme }: { readonly theme: Theme }) {
	const text = { color: theme.text };
	const [families, setFamilies] = useState<Families>();

	// Reload on focus, so returning from the sign-in screen shows the new session.
	useFocusEffect(
		useCallback(() => {
			let cancel = () => {};
			let stopped = false;
			void readSession().then((session) => {
				if (stopped) return;
				if (session === null) setFamilies({ kind: "signed_out" });
				else
					cancel = loadDecoded(
						FamilyList,
						`${ENV.EXPO_PUBLIC_SERVER_URL}/api/families`,
						setFamilies,
						{ Authorization: `Bearer ${session.idToken}` },
					);
			});
			return () => {
				stopped = true;
				cancel();
			};
		}, []),
	);

	const signOut = () =>
		void writeSession(null).then(() => setFamilies({ kind: "signed_out" }));

	return (
		<View
			style={[
				styles.card,
				{ backgroundColor: theme.card, borderColor: theme.border },
			]}
		>
			<Text style={[styles.title, text]}>Family</Text>
			{families === undefined && <Text style={text}>Loading…</Text>}
			{families?.kind === "signed_out" && (
				<Link
					href="/sign-in"
					style={[styles.button, text, { borderColor: theme.text }]}
				>
					Sign in to see your family
				</Link>
			)}
			{families?.kind === "error" && (
				<Text accessibilityRole="alert" style={text}>
					Family data unavailable: {families.message}
				</Text>
			)}
			{families?.kind === "ready" &&
				(families.value.families.length === 0 ? (
					<Text style={text}>You are not in a family yet.</Text>
				) : (
					families.value.families.map((family) => (
						<Text key={family.id} style={text}>
							{family.name}
						</Text>
					))
				))}
			{families !== undefined && families.kind !== "signed_out" && (
				<Pressable
					accessibilityRole="button"
					onPress={signOut}
					style={[styles.button, { borderColor: theme.text }]}
				>
					<Text style={text}>Sign out</Text>
				</Pressable>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	scrollView: {
		flex: 1,
		paddingHorizontal: 20,
		paddingTop: 28,
	},
	content: {
		gap: 16,
	},
	card: {
		padding: 16,
		borderWidth: 1,
		gap: 8,
	},
	title: {
		fontWeight: "600",
	},
	button: {
		minHeight: 44,
		borderWidth: 2,
		paddingHorizontal: 16,
		textAlignVertical: "center",
		alignItems: "center",
		justifyContent: "center",
	},
});
