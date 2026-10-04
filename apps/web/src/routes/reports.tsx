import { createFileRoute } from "@tanstack/react-router";

import { ReportScreen } from "@/components/reports/report-sheet";

export const Route = createFileRoute("/reports")({
	component: () => (
		<main className="mx-auto w-full max-w-4xl p-2 md:p-6">
			<ReportScreen />
		</main>
	),
});
