import type { Family } from "@health/contracts";
import { buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { ExerciseSection } from "@/components/exercise/plans";
import { type FamilyData, useFamilyData } from "@/components/family/data";
import {
	AlertSection,
	FamilyGate,
	MonitoringBadge,
	MonitoringList,
	ReadingsGlance,
} from "@/components/family/parts";
import { Window } from "@/components/hud/window";
import { ReminderHistorySection } from "@/components/reminders/history";
import { FamilyLocationSection } from "@/components/trip/location";
import { ApiNotice } from "@/components/win95";
import { senderLabel } from "@/lib/members";

export const Route = createFileRoute("/family")({
	component: FamilyPhone,
});

function FamilyPhone() {
	const data = useFamilyData();
	return (
		<main className="win95-desktop min-h-0 overflow-y-auto p-2 sm:p-4">
			<Window
				title={`Family · ${data.family?.name ?? "No person"}`}
				icon={Users}
				className="mx-auto w-full max-w-xl"
			>
				<FamilyGate data={data} emptyClassName="p-3 text-sm">
					{(family) => <FamilyBody data={data} family={family} />}
				</FamilyGate>
			</Window>
		</main>
	);
}

function FamilyBody({ data, family }: { data: FamilyData; family: Family }) {
	const now = Date.now();
	return (
		<div className="grid gap-4 p-2 text-sm">
			<header className="flex items-center gap-3">
				<span
					aria-hidden
					className="win95-raised grid size-12 shrink-0 place-items-center bg-primary font-bold text-primary-foreground text-xl"
				>
					{family.name.charAt(0).toUpperCase()}
				</span>
				<h2 className="min-w-0 flex-1 break-words font-bold text-2xl">
					{family.name}
				</h2>
				<MonitoringBadge state={data.monitoring} />
			</header>

			<AlertSection data={data} now={now} />

			<FamilyLocationSection familyId={family.id} me={data.me} now={now} />

			<section aria-labelledby="glance" className="grid gap-2">
				<h3 id="glance" className="font-bold">
					Today at a glance
				</h3>
				<ReadingsGlance data={data} familyId={family.id} now={now} />
			</section>

			<section aria-labelledby="monitoring" className="grid gap-2">
				<h3 id="monitoring" className="font-bold">
					Monitoring
				</h3>
				<MonitoringList state={data.monitoring} />
			</section>

			<ReminderHistorySection familyId={family.id} me={data.me} />

			<section aria-labelledby="chat" className="grid gap-2">
				<h3 id="chat" className="font-bold">
					Family chat
				</h3>
				<div className="win95-inset grid gap-2 bg-card p-2">
					{data.records.kind !== "ready" ? (
						<ApiNotice state={data.records} what="messages" />
					) : (
						<ChatPreview
							messages={data.records.value.messages.filter(
								(m) => m.familyId === family.id,
							)}
							me={data.me}
						/>
					)}
					<Link
						to="/chat"
						data-slot="button"
						className={cn(buttonVariants(), "h-11 justify-self-start")}
					>
						Open chat
					</Link>
				</div>
			</section>

			<section aria-labelledby="exercise" className="grid gap-2">
				<h3 id="exercise" className="font-bold">
					Guided exercise
				</h3>
				<ExerciseSection familyId={family.id} />
			</section>
		</div>
	);
}

function ChatPreview({
	messages,
	me,
}: {
	messages: readonly {
		sender: string;
		clientId: string;
		body: string;
		sentAt: string;
	}[];
	me: string | null;
}) {
	const newest = messages.reduce<(typeof messages)[number] | null>(
		(best, m) =>
			best === null || Date.parse(m.sentAt) > Date.parse(best.sentAt)
				? m
				: best,
		null,
	);
	if (newest === null) return <p>No messages yet.</p>;
	return (
		<p className="line-clamp-3 break-words">
			<b>{senderLabel(newest, me)}</b>
			{": "}
			{newest.body}
		</p>
	);
}
