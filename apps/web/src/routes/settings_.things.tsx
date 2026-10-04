import { MedicineMemory } from "@health/contracts/medicine-memory";
import { createFileRoute } from "@tanstack/react-router";

import { SavedThingsSettings } from "@/components/settings/saved-things";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/settings_/things")({
	loader: loadFamilyReads((familyId) => [
		[MedicineMemory, familyPath(familyId, "/medicine-memory")],
	]),
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<SavedThingsSettings />
		</main>
	),
});
