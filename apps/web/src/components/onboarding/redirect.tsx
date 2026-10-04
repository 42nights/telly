import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { useFamily } from "@/lib/family";

import { onboardingTarget } from "./logic";

/**
 * Sends a signed-in person with no family to onboarding, on every screen except onboarding itself
 * and the join screen. Sign-in has its own landing rule and renders outside FamilyProvider.
 */
export function OnboardingRedirect() {
	const { state } = useFamily();
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const target =
		state.kind === "ready"
			? onboardingTarget(pathname, state.value.families.length === 0)
			: null;
	useEffect(() => {
		if (target !== null) void navigate({ href: target, replace: true });
	}, [target, navigate]);
	return null;
}
