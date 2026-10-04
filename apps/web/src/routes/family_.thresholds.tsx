import { createFileRoute } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";

import { familyReads, useFamilyData } from "@/components/family/data";
import { Thresholds } from "@/components/family/overview";
import { FamilyGate } from "@/components/family/parts";
import { Window } from "@/components/hud/window";
import { loadFamilyReads } from "@/lib/family";

// Family › Thresholds: each alert rule and its state now. Read-only.
export const Route = createFileRoute("/family_/thresholds")({
	loader: loadFamilyReads(familyReads),
	component: FamilyThresholds,
});

function FamilyThresholds() {
	const data = useFamilyData();
	return (
		<main className="p-2 sm:p-4">
			<Window
				title={`Alert thresholds · ${data.family?.name ?? "No person"}`}
				icon={SlidersHorizontal}
				className="mx-auto w-full max-w-4xl"
				status="Read-only"
			>
				<FamilyGate data={data} emptyClassName="p-3 text-sm">
					{() => (
						<div className="p-2 text-sm">
							<Thresholds
								state={data.thresholds}
								monitoring={data.monitoring}
							/>
						</div>
					)}
				</FamilyGate>
			</Window>
		</main>
	);
}
