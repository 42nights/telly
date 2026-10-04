import { type Loaded, loadDecoded, Sources } from "@health/contracts";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";
import { ENV } from "@/src/env";

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
				contentInsetAdjustmentBehavior="never"
			>
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
								<Text style={[styles.title, text]}>
									Healer S.I. not connected
								</Text>
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

const styles = StyleSheet.create({
	scrollView: {
		flex: 1,
		paddingHorizontal: 20,
		paddingTop: 28,
	},
	card: {
		padding: 16,
		borderWidth: 1,
		gap: 8,
	},
	title: {
		fontWeight: "600",
	},
});
