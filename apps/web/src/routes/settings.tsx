import { createFileRoute } from "@tanstack/react-router";

import { DemoDataSettings } from "@/components/settings/demo-data";
import { SettingsForm } from "@/components/settings/settings-form";

// Settings › Phone numbers, and Demo data (#334). The other tabs: Home speaker, Going out, Saved
// things, Report email, This device, Family.
export const Route = createFileRoute("/settings")({
	component: () => (
		<main className="mx-auto grid w-full max-w-xl gap-4 p-2 md:p-6">
			<SettingsForm />
			<DemoDataSettings />
		</main>
	),
});
