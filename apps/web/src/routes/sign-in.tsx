import { Button } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { Window } from "@/components/hud/window";
import { getSessionToken } from "@/lib/session";
import { finishSignIn, signInConfig, startSignIn } from "@/lib/sign-in";

type Step =
	| { readonly kind: "ready" }
	| { readonly kind: "working" }
	| { readonly kind: "error"; readonly message: string }
	| { readonly kind: "signed_in" };

const text = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;

const config = signInConfig();

type Search = {
	code?: string | undefined;
	state?: string | undefined;
	error?: string | undefined;
};

export const Route = createFileRoute("/sign-in")({
	validateSearch: (search: Record<string, unknown>): Search => ({
		code: text(search.code),
		state: text(search.state),
		error: text(search.error),
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

function SignIn() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [step, setStep] = useState<Step>(() =>
		getSessionToken() === null ? { kind: "ready" } : { kind: "signed_in" },
	);

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
		finishSignIn(config, reply).then(
			() => setStep({ kind: "signed_in" }),
			(error: unknown) => setStep(failure(error)),
		);
	}, [search, navigate]);

	const start = () => {
		if (config === null) return;
		setStep({ kind: "working" });
		startSignIn(config).catch((error: unknown) => setStep(failure(error)));
	};

	return (
		<main className="mx-auto w-full max-w-md p-2 md:p-6">
			<Window title="Sign in to Telly" icon={KeyRound}>
				<div className="grid gap-3 p-2 text-sm">
					{config === null ? (
						<p role="status">
							Sign-in is not set up on this server. Set VITE_OIDC_ISSUER and
							VITE_OIDC_CLIENT_ID (see issue #4).
						</p>
					) : step.kind === "signed_in" ? (
						<>
							<p role="status">You are signed in.</p>
							<Link to="/family" className="win95-primary win95-tab">
								Go to Family
							</Link>
						</>
					) : (
						<>
							{step.kind === "error" && (
								<p role="alert">Could not sign in. {step.message}</p>
							)}
							<Button
								type="button"
								className="win95-primary h-11 px-4"
								disabled={step.kind === "working"}
								onClick={start}
							>
								{step.kind === "working"
									? "Signing in…"
									: step.kind === "error"
										? "Try again"
										: "Sign in"}
							</Button>
						</>
					)}
				</div>
			</Window>
		</main>
	);
}
