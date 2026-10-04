import { Reports } from "@health/contracts/reports";
import { createFileRoute } from "@tanstack/react-router";

import { ReportScreen } from "@/components/reports/report-sheet";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/reports")({
	loader: loadFamilyReads((familyId) => [
		[Reports, familyPath(familyId, "/reports")],
	]),
	component: () => (
		<main className="mx-auto w-full max-w-4xl p-2 md:p-6">
			<ReportScreen />
		</main>
	),
});
