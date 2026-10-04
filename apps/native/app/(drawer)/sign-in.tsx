// Phone sign-in (issue #4): the OIDC authorization code flow with PKCE (S256), `state`, and `nonce`,
// for a public client, through the system browser. The issuer is configured, never chosen here. The
// ID token goes to SecureStore and becomes the bearer token that the server verifies.
import { tokenClaims } from "@health/contracts/session";
import { Schema } from "effect";
import {
	exchangeCodeAsync,
	makeRedirectUri,
	useAuthRequest,
	useAutoDiscovery,
} from "expo-auth-session";
import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { maybeCompleteAuthSession } from "expo-web-browser";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { writeSessionToken } from "@/lib/session";
import { useColorScheme } from "@/lib/use-color-scheme";
import { ENV } from "@/src/env";

maybeCompleteAuthSession();

const IdClaims = Schema.Struct({ iss: Schema.String, nonce: Schema.String });

const issuer = ENV.EXPO_PUBLIC_OIDC_ISSUER;
const clientId = ENV.EXPO_PUBLIC_OIDC_CLIENT_ID;
const redirectUri = makeRedirectUri({ scheme: "health", path: "sign-in" });

export default function SignIn() {
	const { colorScheme } = useColorScheme();
	const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;
	const text = { color: theme.text };
	return (
		<Container>
			<View
				style={[
					styles.card,
					{ backgroundColor: theme.card, borderColor: theme.border },
				]}
			>
				{issuer && clientId ? (
					<SignInFlow issuer={issuer} clientId={clientId} text={text} />
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

function SignInFlow({
	issuer,
	clientId,
	text,
}: {
	readonly issuer: string;
	readonly clientId: string;
	readonly text: { readonly color: string };
}) {
	const router = useRouter();
	const discovery = useAutoDiscovery(issuer);
	const [nonce] = useState(randomUUID);
	const [request, response, promptAsync] = useAuthRequest(
		{ clientId, redirectUri, scopes: ["openid"], extraParams: { nonce } },
		discovery,
	);
	const [working, setWorking] = useState(false);
	const [problem, setProblem] = useState<string>();

	useEffect(() => {
		if (response === null) return;
		if (response.type !== "success") {
			setWorking(false);
			if (response.type === "error")
				setProblem(
					`The sign-in server said: ${response.error?.message ?? response.params.error ?? "error"}`,
				);
			return;
		}
		const code = response.params.code;
		if (
			discovery === null ||
			request?.codeVerifier === undefined ||
			code === undefined
		)
			return;
		exchangeCodeAsync(
			{
				clientId,
				code,
				redirectUri,
				extraParams: { code_verifier: request.codeVerifier },
			},
			discovery,
		)
			.then(async ({ idToken }) => {
				const claims = Schema.decodeUnknownOption(IdClaims)(
					idToken === undefined ? null : tokenClaims(idToken),
				);
				if (
					idToken === undefined ||
					claims._tag === "None" ||
					claims.value.iss !== issuer ||
					claims.value.nonce !== nonce
				)
					throw new Error(
						"The sign-in server sent a token for another sign-in.",
					);
				await writeSessionToken(idToken);
				router.replace("/");
			})
			.catch((error: unknown) => {
				console.error("Sign-in failed", error);
				setWorking(false);
				setProblem(error instanceof Error ? error.message : String(error));
			});
	}, [response, request, discovery, clientId, issuer, nonce, router]);

	const start = () => {
		setProblem(undefined);
		setWorking(true);
		promptAsync().catch((error: unknown) => {
			setWorking(false);
			setProblem(String(error));
		});
	};

	return (
		<>
			{discovery === null && !problem && (
				<Text style={text}>Contacting the sign-in server…</Text>
			)}
			{problem && (
				<Text accessibilityRole="alert" style={text}>
					Could not sign in. {problem}
				</Text>
			)}
			<Pressable
				accessibilityRole="button"
				disabled={request === null || working}
				onPress={start}
				style={[styles.button, { borderColor: text.color }]}
			>
				<Text style={[styles.label, text]}>
					{working ? "Signing in…" : problem ? "Try again" : "Sign in"}
				</Text>
			</Pressable>
		</>
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
