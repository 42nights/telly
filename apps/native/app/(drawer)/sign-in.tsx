// Phone sign-in (issue #4): the OIDC authorization code flow with PKCE (S256), `state`, and `nonce`,
// through the system browser. The issuer is configured, never chosen here (Google in production).
// Google allows no custom scheme for Android clients, so the phone uses the same web client as the
// web app: the issuer returns to the server's `/api/sign-in/callback`, which sends the reply on to
// `health://sign-in`, and the server's `POST /api/sign-in/token` exchanges the code with the client
// secret. The ID token goes to SecureStore and becomes the bearer token that the server verifies.
import {
	authorizationUrl,
	exchangeSignInCode,
	PHONE_SIGN_IN_RETURN,
	tokenMatches,
} from "@health/contracts/session";
import { Schema } from "effect";
import {
	CryptoDigestAlgorithm,
	CryptoEncoding,
	digestStringAsync,
	randomUUID,
} from "expo-crypto";
import { parse } from "expo-linking";
import { useRouter } from "expo-router";
import { openAuthSessionAsync } from "expo-web-browser";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { writeSessionToken } from "@/lib/session";
import { useColorScheme } from "@/lib/use-color-scheme";
import { ENV } from "@/src/env";

const Discovery = Schema.Struct({ authorization_endpoint: Schema.String });

const issuer = ENV.EXPO_PUBLIC_OIDC_ISSUER;
const clientId = ENV.EXPO_PUBLIC_OIDC_CLIENT_ID;
const server = ENV.EXPO_PUBLIC_SERVER_URL;
const redirectUri = `${server}/api/sign-in/callback`;

/** Runs one sign-in. Resolves with the ID token, or `null` when the person closed the browser. */
const signIn = async (issuer: string, clientId: string) => {
	const response = await fetch(
		`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
	);
	if (!response.ok)
		throw new Error(`The sign-in server replied HTTP ${response.status}.`);
	const { authorization_endpoint } = Schema.decodeUnknownSync(Discovery)(
		await response.json(),
	);
	// Two random UUIDs: 73 characters from the PKCE verifier alphabet.
	const verifier = `${randomUUID()}-${randomUUID()}`;
	const state = randomUUID();
	const nonce = randomUUID();
	const challenge = (
		await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, {
			encoding: CryptoEncoding.BASE64,
		})
	)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const result = await openAuthSessionAsync(
		authorizationUrl(authorization_endpoint, {
			clientId,
			redirectUri,
			state,
			nonce,
			challenge,
		}),
		PHONE_SIGN_IN_RETURN,
	);
	if (result.type !== "success") return null;
	const reply = parse(result.url).queryParams ?? {};
	if (typeof reply.error === "string")
		throw new Error(`The sign-in server said: ${reply.error}`);
	if (reply.state !== state || typeof reply.code !== "string")
		throw new Error(
			"This sign-in reply is not from this sign-in. Sign in again.",
		);
	const idToken = await exchangeSignInCode(server, {
		code: reply.code,
		codeVerifier: verifier,
		redirectUri,
	});
	if (!tokenMatches(idToken, issuer, nonce))
		throw new Error("The sign-in server sent a token for another sign-in.");
	return idToken;
};

export default function SignIn() {
	const { colorScheme } = useColorScheme();
	const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;
	const text = { color: theme.text };
	const router = useRouter();
	const [working, setWorking] = useState(false);
	const [problem, setProblem] = useState<string>();

	const start = (issuer: string, clientId: string) => {
		setProblem(undefined);
		setWorking(true);
		signIn(issuer, clientId)
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
							onPress={() => start(issuer, clientId)}
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
