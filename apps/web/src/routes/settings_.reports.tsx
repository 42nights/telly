import { ReportEmailSettings } from "@health/contracts/reports";
import { createFileRoute } from "@tanstack/react-router";

import { ReportEmailSettingsWindow } from "@/components/settings/report-email";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/settings_/reports")({
	loader: loadFamilyReads((familyId) => [
		[ReportEmailSettings, familyPath(familyId, "/report-email")],
	]),
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<ReportEmailSettingsWindow />
		</main>
	),
});
