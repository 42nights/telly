// Family › Exercise: the agreed guided exercise and its sessions.
import { createFileRoute } from "@tanstack/react-router";
import { Dumbbell } from "lucide-react";

import { ExerciseSection } from "@/components/exercise/plans";
import { familyReads, useFamilyData } from "@/components/family/data";
import { FamilyGate } from "@/components/family/parts";
import { Page } from "@/components/hud/window";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/family_/exercise")({
	loader: loadFamilyReads(familyReads),
	component: FamilyExercise,
});

function FamilyExercise() {
	const data = useFamilyData();
	return (
		<Page
			title={`Guided exercise · ${data.family?.name ?? "No person"}`}
			icon={Dumbbell}
			className="max-w-4xl"
		>
			<FamilyGate data={data} emptyClassName="p-3 text-sm">
				{(family) => (
					<div className="grid content-start gap-2 p-2 text-sm">
						<ExerciseSection familyId={family.id} />
					</div>
				)}
			</FamilyGate>
		</Page>
	);
}
