import { Me } from "@health/contracts/families";
import { buttonVariants } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Window } from "@/components/hud/window";
import { ConnectScreen } from "@/components/onboarding/connect";
import {
	type Mode,
	WelcomeScreen,
	WhoScreen,
} from "@/components/onboarding/screens";
import { ApiNotice } from "@/components/win95";
import { useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

type Search = { step?: "connect" };

export const Route = createFileRoute("/welcome")({
	validateSearch: (search: Record<string, unknown>): Search =>
		search.step === "connect" ? { step: "connect" } : {},
	component: Welcome,
});

/** Onboarding screens 2–4 (.lavish/onboarding-plan.html#proposed), one window each. */
function Welcome() {
	const { step } = Route.useSearch();
	const navigate = Route.useNavigate();
	const me = useApi(Me, "/api/me");
	const { state: families, family } = useFamily();
	const [mode, setMode] = useState<Mode | null>(null);

	const screen = (title: string, body: ReactNode) => (
		<main className="mx-auto w-full max-w-[480px] p-2 md:p-6">
			<Window title={title} icon={Sparkles}>
				{body}
			</Window>
		</main>
	);

	if (step === "connect") {
		if (family === null)
			return screen(
				"Step 2 of 2 · Real data",
				families.kind === "ready" ? (
					<p className="p-2">No person is set up yet.</p>
				) : (
					<ApiNotice state={families} what="your family" />
				),
			);
		return screen(
			"Step 2 of 2 · Real data",
			<ConnectScreen family={family} key={family.id} />,
		);
	}
	if (me.kind === "signed_out")
		return screen(
			"Welcome",
			<div className="grid gap-3 p-2">
				<p>Sign in first. This makes your account if you are new.</p>
				<Link
					className={buttonVariants({ className: "win95-primary h-11 w-full" })}
					data-slot="button"
					to="/sign-in"
				>
					Sign in
				</Link>
			</div>,
		);
	if (me.kind !== "ready")
		return screen("Welcome", <ApiNotice state={me} what="your profile" />);
	if (mode === null)
		return screen("Welcome", <WelcomeScreen me={me.value} onStart={setMode} />);
	return screen(
		"Step 1 of 2 · Who you care for",
		<WhoScreen
			me={me.value}
			mode={mode}
			onDone={() => void navigate({ search: { step: "connect" } })}
		/>,
	);
}
