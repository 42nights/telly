import { createFileRoute, redirect } from "@tanstack/react-router";

// The medicine finder is now Find things (#301); old links keep their request.
export const Route = createFileRoute("/medicine")({
	beforeLoad: ({ search }: { search: { q?: string } }) => {
		throw redirect({ to: "/find", search, replace: true });
	},
	validateSearch: (search: Record<string, unknown>): { q?: string } =>
		typeof search.q === "string" ? { q: search.q } : {},
});
