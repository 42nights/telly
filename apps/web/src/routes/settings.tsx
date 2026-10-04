import { createFileRoute } from "@tanstack/react-router";

import { SettingsForm } from "@/components/settings/settings-form";

export const Route = createFileRoute("/settings")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<SettingsForm />
		</main>
	),
});
