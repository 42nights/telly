// Family › Reminders: the meal and drink reminders Telly texts to the person.
import { createFileRoute } from "@tanstack/react-router";
import { Bell } from "lucide-react";

import { familyReads, useFamilyData } from "@/components/family/data";
import { FamilyGate } from "@/components/family/parts";
import { Page } from "@/components/hud/window";
import { MealReminders } from "@/components/meal-check-in/reminders";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/family_/reminders")({
	loader: loadFamilyReads(familyReads),
	component: FamilyReminders,
});

function FamilyReminders() {
	const data = useFamilyData();
	return (
		<Page
			title={`Reminders · ${data.family?.name ?? "No person"}`}
			icon={Bell}
			className="max-w-4xl"
		>
			<FamilyGate data={data} emptyClassName="p-3 text-sm">
				{(family) => (
					<div className="grid min-h-0 flex-1 content-start overflow-y-auto p-2 text-sm">
						<MealReminders familyId={family.id} />
					</div>
				)}
			</FamilyGate>
		</Page>
	);
}
