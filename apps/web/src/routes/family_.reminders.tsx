// Family › Reminders: the person's meal and drink reminders, with Add and Delete.
import { Reminders, SavedReminderSettings } from "@health/contracts/reminders";
import { createFileRoute } from "@tanstack/react-router";
import { BellRing } from "lucide-react";

import { familyReads, useFamilyData } from "@/components/family/data";
import { FamilyGate } from "@/components/family/parts";
import { Page } from "@/components/hud/window";
import { MealReminders } from "@/components/meal-check-in/family-status";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/family_/reminders")({
	loader: loadFamilyReads((familyId) => [
		...familyReads(familyId),
		[Reminders, familyPath(familyId, "/reminders")],
		[SavedReminderSettings, familyPath(familyId, "/reminder-settings")],
	]),
	component: FamilyReminders,
});

function FamilyReminders() {
	const data = useFamilyData();
	return (
		<Page
			title={`Reminders · ${data.family?.name ?? "No person"}`}
			icon={BellRing}
			className="max-w-4xl"
		>
			<FamilyGate data={data} emptyClassName="p-3 text-sm">
				{(family) => (
					<div className="grid min-h-0 content-start gap-2 p-2 text-sm">
						<MealReminders familyId={family.id} />
					</div>
				)}
			</FamilyGate>
		</Page>
	);
}
