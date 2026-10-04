import { FamilyList } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { Window } from "@/components/hud/window";
import { apiQuery } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { getSessionToken, returnPath } from "@/lib/session";
import { finishSignIn, signInConfig, startSignIn } from "@/lib/sign-in";

type Step =
	| { readonly kind: "ready" }
	| { readonly kind: "working" }
	| { readonly kind: "error"; readonly message: string };

const text = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;

const config = signInConfig();

type Search = {
	code?: string | undefined;
	state?: string | undefined;
	error?: string | undefined;
	/** The app page that sent the visitor here; sign-in returns to it. */
	redirect?: string | undefined;
};

export const Route = createFileRoute("/sign-in")({
	validateSearch: (search: Record<string, unknown>): Search => ({
		code: text(search.code),
		state: text(search.state),
		error: text(search.error),
		redirect: text(search.redirect),
	}),
	component: SignIn,
});

const failure = (error: unknown): Step => {
	console.error("Sign-in failed", error);
	return {
		kind: "error",
		message: error instanceof Error ? error.message : String(error),
	};
};

/**
 * A first-time user with no family starts onboarding, unless they came to join a family by invite.
 * The list it reads stays cached for the first screen.
 */
const landing = async (returnTo: string) => {
	const path = returnPath(returnTo);
	const none = await queryClient
		.fetchQuery(apiQuery(FamilyList, "/api/families"))
		.then(
			(list) => list.families.length === 0,
			() => false,
		);
	return none && !path.startsWith("/join/") ? "/welcome" : path;
};

function SignIn() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [step, setStep] = useState<Step>({ kind: "ready" });
	useEffect(() => {
		if (config === null) return;
		if (search.error !== undefined) {
			setStep({
				kind: "error",
				message: `The sign-in server said: ${search.error}`,
			});
			return;
		}
		if (search.code === undefined || search.state === undefined) return;
		const reply = { code: search.code, state: search.state };
		// Remove the one-time code from the address bar before it is used.
		void navigate({ search: {}, replace: true });
		setStep({ kind: "working" });
		finishSignIn(config, reply)
			.then(landing)
			.then(
				(href) => navigate({ href, replace: true }),
				(error: unknown) => setStep(failure(error)),
			);
	}, [search, navigate]);

	// Already signed in, and not finishing a sign-in: go to the app.
	const leave =
		step.kind === "ready" &&
		search.code === undefined &&
		getSessionToken() !== null;
	useEffect(() => {
		if (leave)
			void navigate({ href: returnPath(search.redirect), replace: true });
	}, [leave, search.redirect, navigate]);
	if (leave) return null;

	const start = () => {
		if (config === null) return;
		setStep({ kind: "working" });
		startSignIn(config, returnPath(search.redirect)).catch((error: unknown) =>
			setStep(failure(error)),
		);
	};

	return (
		<main className="mx-auto w-full max-w-md p-3 md:p-6">
			<Window title="Sign in to Telly" icon={KeyRound}>
				<div className="grid gap-4 p-3 text-base">
					<h3 className="font-bold text-xl">Sign in or create an account</h3>
					<p>
						Telly shows a family's care information only to the people in that
						family.
					</p>
					{config === null ? (
						<p role="status">
							Sign-in is not set up on this server. Set VITE_OIDC_ISSUER and
							VITE_OIDC_CLIENT_ID (see issue #4).
						</p>
					) : (
						<>
							<p>
								Use your Google account. If you are new to Telly, this also
								creates your account.
							</p>
							{step.kind === "error" && (
								<p role="alert" className="win95-inset bg-card p-2">
									Could not sign in. {step.message}
								</p>
							)}
							<Button
								type="button"
								className="win95-primary h-11 w-full px-4 text-base"
								disabled={step.kind === "working"}
								onClick={start}
							>
								{step.kind === "working"
									? "Signing in…"
									: step.kind === "error"
										? "Try again with Google"
										: "Continue with Google"}
							</Button>
						</>
					)}
				</div>
			</Window>
		</main>
	);
}
