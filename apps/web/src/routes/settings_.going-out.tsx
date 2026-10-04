import { createFileRoute } from "@tanstack/react-router";

import { GoingOutSettings } from "@/components/settings/going-out";

export const Route = createFileRoute("/settings_/going-out")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<GoingOutSettings />
		</main>
	),
});
