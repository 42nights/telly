// Family › Overview (docs/board.html#wf-phone, #wf-dash): the alert to act on, today's readings,
// monitoring, messages, and the plans. The other Family tabs are Alerts, Trends, and Thresholds.
import type { Family } from "@health/contracts";
import { buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { CookingAbilities } from "@/components/cooking/abilities";
import { ExerciseSection } from "@/components/exercise/plans";
import {
	type FamilyData,
	familyReads,
	useFamilyData,
} from "@/components/family/data";
import {
	KeyNumbers,
	RecentMessages,
	SourceList,
} from "@/components/family/overview";
import {
	AlertSection,
	FamilyGate,
	MonitoringBadge,
	MonitoringList,
	ReadingsGlance,
} from "@/components/family/parts";
import { Window } from "@/components/hud/window";
import { MealStatusSection } from "@/components/meal-check-in/family-status";
import { ReminderHistorySection } from "@/components/reminders/history";
import { FamilyLocationSection } from "@/components/trip/location";
import { loadFamilyReads, PersonPicker } from "@/lib/family";

export const Route = createFileRoute("/family")({
	loader: loadFamilyReads(familyReads),
	component: FamilyOverview,
});

function FamilyOverview() {
	const data = useFamilyData();
	return (
		<main className="p-2 sm:p-4">
			<Window
				title={`Family · ${data.family?.name ?? "No person"}`}
				icon={Users}
				className="mx-auto w-full max-w-4xl"
			>
				<PersonPicker className="p-2 [&_select]:min-w-0 [&_select]:flex-1" />
				<FamilyGate data={data} emptyClassName="p-3 text-sm">
					{(family) => <Overview key={family.id} data={data} family={family} />}
				</FamilyGate>
			</Window>
		</main>
	);
}

function Overview({ data, family }: { data: FamilyData; family: Family }) {
	const now = Date.now();
	return (
		<div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-2 text-sm">
			<header className="flex flex-wrap items-center gap-3">
				<span
					aria-hidden
					className="win95-raised grid size-12 shrink-0 place-items-center bg-primary font-bold text-primary-foreground text-xl"
				>
					{family.name.charAt(0).toUpperCase()}
				</span>
				<h2 className="min-w-0 flex-[1_1_10rem] break-words font-bold text-2xl">
					{family.name}
				</h2>
				<MonitoringBadge state={data.monitoring} />
			</header>

			<AlertSection data={data} now={now} />

			<FamilyLocationSection familyId={family.id} me={data.me} now={now} />
			<MealStatusSection familyId={family.id} />

			<section aria-labelledby="glance" className="grid gap-2">
				<h3 id="glance" className="font-bold">
					Today at a glance
				</h3>
				<KeyNumbers data={data} family={family} />
				<ReadingsGlance data={data} familyId={family.id} now={now} />
				<SourceList />
			</section>

			<section aria-labelledby="monitoring" className="grid gap-2">
				<h3 id="monitoring" className="font-bold">
					Monitoring
				</h3>
				<MonitoringList
					state={data.monitoring}
					records={data.records}
					familyId={family.id}
					now={now}
				/>
			</section>

			<ReminderHistorySection familyId={family.id} me={data.me} />

			<section aria-labelledby="chat" className="grid gap-2">
				<h3 id="chat" className="font-bold">
					Recent messages
				</h3>
				<RecentMessages data={data} familyId={family.id} />
				<Link
					to="/chat"
					data-slot="button"
					className={cn(buttonVariants(), "h-11 justify-self-start")}
				>
					Open chat
				</Link>
			</section>

			<section aria-labelledby="exercise" className="grid gap-2">
				<h3 id="exercise" className="font-bold">
					Guided exercise
				</h3>
				<ExerciseSection familyId={family.id} />
			</section>

			<section aria-labelledby="cooking" className="grid gap-2">
				<h3 id="cooking" className="font-bold">
					Cooking abilities
				</h3>
				<div className="win95-inset grid gap-2 bg-card p-2">
					<CookingAbilities familyId={family.id} />
				</div>
			</section>
		</div>
	);
}
