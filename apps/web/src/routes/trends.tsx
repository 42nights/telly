import { createFileRoute, redirect } from "@tanstack/react-router";

// Trends is now a tab of the Family screen.
export const Route = createFileRoute("/trends")({
	beforeLoad: () => {
		throw redirect({ to: "/family/trends", replace: true });
	},
});
