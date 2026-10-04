import { createFileRoute, redirect } from "@tanstack/react-router";

// The care plan is now the Care screen's Care plan tab.
export const Route = createFileRoute("/care-profile")({
	beforeLoad: () => {
		throw redirect({ to: "/care/plan", replace: true });
	},
});
