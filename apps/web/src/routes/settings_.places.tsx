import { MedicineMemory } from "@health/contracts/medicine-memory";
import { createFileRoute } from "@tanstack/react-router";

import { MedicineMemorySettings } from "@/components/settings/medicine-memory";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/settings_/places")({
	loader: loadFamilyReads((familyId) => [
		[MedicineMemory, familyPath(familyId, "/medicine-memory")],
	]),
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<MedicineMemorySettings />
		</main>
	),
});
