import { createFileRoute, redirect } from "@tanstack/react-router";

// Care needs and the contact ladder live on the care plan screen (#209); old links still work.
export const Route = createFileRoute("/care")({
	beforeLoad: () => {
		throw redirect({ to: "/care-profile" });
	},
});
