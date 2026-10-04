// Phone sign-in screen (issue #4). The flow is in `lib/sign-in.ts`.
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { writeSessionToken } from "@/lib/session";
import { clientId, issuer, signIn } from "@/lib/sign-in";
import { useColorScheme } from "@/lib/use-color-scheme";

export default function SignIn() {
	const { colorScheme } = useColorScheme();
	const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;
	const text = { color: theme.text };
	const router = useRouter();
	const [working, setWorking] = useState(false);
	const [problem, setProblem] = useState<string>();

	const start = () => {
		setProblem(undefined);
		setWorking(true);
		signIn()
			.then(async (idToken) => {
				setWorking(false);
				if (idToken === null) return;
				await writeSessionToken(idToken);
				router.replace("/");
			})
			.catch((error: unknown) => {
				console.error("Sign-in failed", error);
				setWorking(false);
				setProblem(error instanceof Error ? error.message : String(error));
			});
	};

	return (
		<Container>
			<View
				style={[
					styles.card,
					{ backgroundColor: theme.card, borderColor: theme.border },
				]}
			>
				{issuer && clientId ? (
					<>
						{problem && (
							<Text accessibilityRole="alert" style={text}>
								Could not sign in. {problem}
							</Text>
						)}
						<Pressable
							accessibilityRole="button"
							disabled={working}
							onPress={start}
							style={[styles.button, { borderColor: theme.text }]}
						>
							<Text style={[styles.label, text]}>
								{working ? "Signing in…" : problem ? "Try again" : "Sign in"}
							</Text>
						</Pressable>
					</>
				) : (
					<Text style={text}>
						Sign-in is not set up in this app. Set EXPO_PUBLIC_OIDC_ISSUER and
						EXPO_PUBLIC_OIDC_CLIENT_ID (see issue #4).
					</Text>
				)}
			</View>
		</Container>
	);
}

const styles = StyleSheet.create({
	card: {
		margin: 20,
		padding: 16,
		borderWidth: 1,
		gap: 12,
	},
	button: {
		minHeight: 44,
		borderWidth: 2,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 16,
	},
	label: {
		fontWeight: "600",
	},
});
