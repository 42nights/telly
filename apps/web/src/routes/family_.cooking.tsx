// Family › Cooking: what the person may do alone in the kitchen.
import { createFileRoute } from "@tanstack/react-router";
import { ChefHat } from "lucide-react";

import { CookingAbilities } from "@/components/cooking/abilities";
import { useFamilyData } from "@/components/family/data";
import { FamilyGate } from "@/components/family/parts";
import { Page } from "@/components/hud/window";

export const Route = createFileRoute("/family_/cooking")({
	component: FamilyCooking,
});

function FamilyCooking() {
	const data = useFamilyData();
	return (
		<Page
			title={`Cooking abilities · ${data.family?.name ?? "No person"}`}
			icon={ChefHat}
			className="max-w-4xl"
		>
			<FamilyGate data={data} emptyClassName="p-3 text-sm">
				{(family) => (
					<div className="grid content-start gap-2 p-2 text-sm">
						<CookingAbilities familyId={family.id} />
					</div>
				)}
			</FamilyGate>
		</Page>
	);
}
