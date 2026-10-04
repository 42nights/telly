import { createFileRoute } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";

import { useFamilyData } from "@/components/family/data";
import { Thresholds } from "@/components/family/overview";
import { FamilyGate } from "@/components/family/parts";
import { Window } from "@/components/hud/window";

// Family › Thresholds: each alert rule and its state now. Read-only.
export const Route = createFileRoute("/family_/thresholds")({
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
				status="Read-only here. A rule without a fresh validated reading shows as unavailable, never as passing."
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
