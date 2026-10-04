// Family › Daily: where the person is, and their reminders today. Each part shows only when it has
// something; with nothing at all, one line says so.
import { createFileRoute } from "@tanstack/react-router";
import { CalendarCheck } from "lucide-react";

import { familyReads, useFamilyData } from "@/components/family/data";
import { FamilyGate } from "@/components/family/parts";
import { Page } from "@/components/hud/window";
import { ReminderHistorySection } from "@/components/reminders/history";
import { FamilyLocationSection } from "@/components/trip/location";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/family_/daily")({
	loader: loadFamilyReads(familyReads),
	component: FamilyDaily,
});

function FamilyDaily() {
	const data = useFamilyData();
	return (
		<Page
			title={`Daily · ${data.family?.name ?? "No person"}`}
			icon={CalendarCheck}
			className="max-w-4xl"
		>
			<FamilyGate data={data} emptyClassName="p-3 text-sm">
				{(family) => (
					<>
						<div className="peer grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-2 text-sm empty:hidden">
							<FamilyLocationSection
								familyId={family.id}
								me={data.me}
								now={Date.now()}
							/>
							<ReminderHistorySection familyId={family.id} me={data.me} />
						</div>
						<p className="hidden p-2 text-sm peer-empty:block">
							Nothing to show for today yet.
						</p>
					</>
				)}
			</FamilyGate>
		</Page>
	);
}
