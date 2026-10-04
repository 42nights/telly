import { createFileRoute, redirect } from "@tanstack/react-router";

// The wearer home is the app's start screen.
export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({ to: "/hud" });
	},
});
