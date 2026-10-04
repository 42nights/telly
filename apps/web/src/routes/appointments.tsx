import { createFileRoute } from "@tanstack/react-router";

import { AppointmentsScreen } from "@/components/appointments/screen";

export const Route = createFileRoute("/appointments")({
	component: () => (
		<main className="mx-auto w-full max-w-4xl p-2 md:p-6">
			<AppointmentsScreen />
		</main>
	),
});
