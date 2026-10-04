import { createFileRoute, redirect } from "@tanstack/react-router";

// The dashboard's numbers, alert history, and messages live on the family screen (#209); old
// links still work.
export const Route = createFileRoute("/dashboard")({
	beforeLoad: () => {
		throw redirect({ to: "/family" });
	},
});
