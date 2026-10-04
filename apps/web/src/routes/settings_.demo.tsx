import { createFileRoute } from "@tanstack/react-router";

import { DemoDataSettings } from "@/components/settings/demo-data";

// Settings › Demo data (#334), a tab of its own so Phone numbers fits a phone screen.
export const Route = createFileRoute("/settings_/demo")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<DemoDataSettings />
		</main>
	),
});
