import { createFileRoute, redirect } from "@tanstack/react-router";

// The dashboard is now the Family screen; old links open its Overview tab.
export const Route = createFileRoute("/dashboard")({
	beforeLoad: () => {
		throw redirect({ to: "/family", replace: true });
	},
});
