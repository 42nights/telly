import type { Family } from "@health/contracts";
import { buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { CookingAbilities } from "@/components/cooking/abilities";
import { ExerciseSection } from "@/components/exercise/plans";
import { type FamilyData, useFamilyData } from "@/components/family/data";
import {
	AlertSection,
	FamilyGate,
	MonitoringBadge,
	MonitoringList,
} from "@/components/family/parts";
import { KeyNumbers, RecentMessages } from "@/components/family/sections";
import { Window } from "@/components/hud/window";
import { MealStatusSection } from "@/components/meal-check-in/family-status";
import { ReminderHistorySection } from "@/components/reminders/history";
import { FamilyLocationSection } from "@/components/trip/location";
import { PersonPicker } from "@/lib/family";

// Family › Overview: the person's state at a glance. The other Family tabs are Alerts, Trends, and
// Thresholds.
export const Route = createFileRoute("/family")({
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
				<FamilyGate data={data} emptyClassName="p-3 text-sm">
					{(family) => <Overview data={data} family={family} />}
				</FamilyGate>
			</Window>
		</main>
	);
}

function Overview({ data, family }: { data: FamilyData; family: Family }) {
	const now = Date.now();
	return (
		<div className="grid gap-4 p-2 text-sm">
			<header className="flex flex-wrap items-center gap-3">
				<span
					aria-hidden
					className="win95-raised grid size-12 shrink-0 place-items-center bg-primary font-bold text-primary-foreground text-xl"
				>
					{family.name.charAt(0).toUpperCase()}
				</span>
				<h2 className="min-w-0 break-words font-bold text-2xl">
					{family.name}
				</h2>
				<MonitoringBadge state={data.monitoring} />
				<PersonPicker className="ml-auto max-w-full [&_select]:min-w-0 [&_select]:flex-1" />
			</header>

			<AlertSection data={data} now={now} />

			<FamilyLocationSection familyId={family.id} me={data.me} now={now} />
			<MealStatusSection familyId={family.id} />

			<KeyNumbers data={data} family={family} now={now} />

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

			<section aria-labelledby="messages" className="grid gap-2">
				<h3 id="messages" className="font-bold">
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
