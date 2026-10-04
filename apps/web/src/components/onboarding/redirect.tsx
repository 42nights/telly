import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { useFamily } from "@/lib/family";

import { onboardingTarget } from "./logic";

/** The invite code a signed-out person opened, kept until they sign in and see the join screen. */
export const PENDING_JOIN = "telly.join";

/**
 * Sends a signed-in person with no family to onboarding, or to the invite they opened before
 * signing in. `pathname` null turns it off (such as before sign-in finishes).
 */
export function useOnboardingRedirect(pathname: string | null) {
	const { state } = useFamily();
	const navigate = useNavigate();
	const target =
		pathname !== null && state.kind === "ready"
			? onboardingTarget(
					pathname,
					state.value.families.length === 0,
					localStorage.getItem(PENDING_JOIN),
				)
			: null;
	useEffect(() => {
		if (target !== null) void navigate({ href: target, replace: true });
	}, [target, navigate]);
}

/** The app-wide redirect, for every screen except sign-in and the join screen. */
export function OnboardingRedirect() {
	useOnboardingRedirect(useRouterState({ select: (s) => s.location.pathname }));
	return null;
}
