import { createFileRoute } from "@tanstack/react-router";

import { ReportEmailSettingsWindow } from "@/components/settings/report-email";

export const Route = createFileRoute("/settings_/reports")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<ReportEmailSettingsWindow />
		</main>
	),
});
