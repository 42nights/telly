import { createFileRoute } from "@tanstack/react-router";

import { MedicineMemorySettings } from "@/components/settings/medicine-memory";

export const Route = createFileRoute("/settings_/places")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<MedicineMemorySettings />
		</main>
	),
});
