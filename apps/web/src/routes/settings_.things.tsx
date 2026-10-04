import { createFileRoute } from "@tanstack/react-router";

import { SavedThingsSettings } from "@/components/settings/saved-things";

export const Route = createFileRoute("/settings_/things")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<SavedThingsSettings />
		</main>
	),
});
