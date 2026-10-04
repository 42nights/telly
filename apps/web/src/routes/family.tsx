// Family › Overview (docs/board.html#wf-phone, #wf-dash): the alert to act on and today's readings.
// The other Family tabs: Daily, Exercise, Cooking, Alerts, Trends, and Thresholds.
import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { useFamilyData } from "@/components/family/data";
import { FamilyPeople } from "@/components/family/invite";
import {
	AlertSection,
	FamilyGate,
	ReadingsGlance,
} from "@/components/family/parts";
import { Page } from "@/components/hud/window";
import { PersonPicker } from "@/lib/family";

export const Route = createFileRoute("/family")({
	component: FamilyOverview,
});

function FamilyOverview() {
	const data = useFamilyData();
	return (
		<Page
			title={`Family · ${data.family?.name ?? "No person"}`}
			icon={Users}
			className="max-w-4xl"
		>
			<PersonPicker className="p-2 [&_select]:min-w-0 [&_select]:flex-1" />
			<FamilyGate data={data} emptyClassName="p-3 text-sm">
				{(family) => (
					<div className="flex min-h-0 flex-1 flex-col gap-2 p-2 text-sm">
						<FamilyPeople
							familyId={family.id}
							familyName={family.name}
							me={data.me}
						/>
						<AlertSection data={data} now={Date.now()} />
						<section
							aria-labelledby="glance"
							className="flex min-h-0 flex-1 flex-col gap-1"
						>
							<h3 id="glance" className="font-bold">
								Today at a glance
							</h3>
							<ReadingsGlance
								data={data}
								familyId={family.id}
								now={Date.now()}
							/>
						</section>
					</div>
				)}
			</FamilyGate>
		</Page>
	);
}
