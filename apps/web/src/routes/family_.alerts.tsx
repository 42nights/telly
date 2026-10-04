import { createFileRoute } from "@tanstack/react-router";
import { Bell } from "lucide-react";

import { useFamilyData } from "@/components/family/data";
import { RecentAlerts } from "@/components/family/overview";
import { AlertSection, FamilyGate } from "@/components/family/parts";
import { Window } from "@/components/hud/window";

// Family › Alerts: the alert to act on now, then every recorded alert with its delivery and who saw it.
export const Route = createFileRoute("/family_/alerts")({
	component: FamilyAlerts,
});

function FamilyAlerts() {
	const data = useFamilyData();
	return (
		<main className="p-2 sm:p-4">
			<Window
				title={`Alerts · ${data.family?.name ?? "No person"}`}
				icon={Bell}
				className="mx-auto w-full max-w-4xl"
			>
				<FamilyGate data={data} emptyClassName="p-3 text-sm">
					{() => (
						<div className="grid gap-3 p-2 text-sm">
							<AlertSection data={data} now={Date.now()} />
							<h3 className="font-bold">Recent alerts</h3>
							<div className="win95-inset overflow-x-auto bg-card">
								<RecentAlerts data={data} />
							</div>
						</div>
					)}
				</FamilyGate>
			</Window>
		</main>
	);
}
