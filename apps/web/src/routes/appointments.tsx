import { Appointments } from "@health/contracts/appointments";
import { createFileRoute } from "@tanstack/react-router";

import { AppointmentsScreen } from "@/components/appointments/screen";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/appointments")({
	loader: loadFamilyReads((familyId) => [
		[Appointments, familyPath(familyId, "/appointments")],
	]),
	component: () => (
		<main className="mx-auto w-full max-w-4xl p-2 md:p-6">
			<AppointmentsScreen />
		</main>
	),
});
