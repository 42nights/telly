import { createFileRoute } from "@tanstack/react-router";

import { DeleteFamilySettings } from "@/components/settings/delete-family";

export const Route = createFileRoute("/settings_/family")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<DeleteFamilySettings />
		</main>
	),
});
