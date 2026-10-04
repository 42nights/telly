// The family screen (docs/board.html#wf-phone, #wf-dash): the alert to act on, today's readings,
// monitoring, alert history, messages, and the plans. It also holds the old dashboard (#209).
import {
	type Family,
	type Loaded,
	loadDecoded,
	type NoopConnection,
	Sources,
} from "@health/contracts";
import type { FamilyAlert } from "@health/contracts/alerts";
import { buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useEffect, useState } from "react";

import { CookingAbilities } from "@/components/cooking/abilities";
import { ExerciseSection } from "@/components/exercise/plans";
import { type FamilyData, useFamilyData } from "@/components/family/data";
import { clock, deliveryText } from "@/components/family/logic";
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
import { ApiNotice } from "@/components/win95";
import { ENV } from "@/env";
import { PersonPicker } from "@/lib/family";
import { memberLabel, senderLabel } from "@/lib/members";

export const Route = createFileRoute("/family")({
	component: FamilyPhone,
});

const linkButton = cn(buttonVariants(), "h-11 justify-self-start");

function FamilyPhone() {
	const data = useFamilyData();
	return (
		<main className="win95-desktop min-h-0 overflow-y-auto p-2 sm:p-4">
			<Window
				title={`Family · ${data.family?.name ?? "No person"}`}
				icon={Users}
				className="mx-auto w-full max-w-3xl"
			>
				<PersonPicker className="p-2 [&_select]:min-w-0 [&_select]:flex-1" />
				<FamilyGate data={data} emptyClassName="p-3 text-sm">
					{(family) => (
						<FamilyBody key={family.id} data={data} family={family} />
					)}
				</FamilyGate>
			</Window>
		</main>
	);
}

function FamilyBody({ data, family }: { data: FamilyData; family: Family }) {
	const now = Date.now();
	const [sources, setSources] = useState<Loaded<Sources>>();
	useEffect(
		() =>
			loadDecoded(Sources, `${ENV.VITE_SERVER_URL}/api/sources`, setSources),
		[],
	);
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
				<SourceList sources={sources} />
				<Link to="/trends" data-slot="button" className={linkButton}>
					See trends
				</Link>
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

			<section aria-labelledby="recent" className="grid gap-2">
				<h3 id="recent" className="font-bold">
					Recent alerts
				</h3>
				<div className="win95-inset max-h-64 overflow-auto bg-card">
					<RecentAlerts data={data} />
				</div>
			</section>

			<ReminderHistorySection familyId={family.id} me={data.me} />

			<section aria-labelledby="chat" className="grid gap-2">
				<h3 id="chat" className="font-bold">
					Recent messages
				</h3>
				<RecentMessages data={data} familyId={family.id} />
				<Link to="/chat" data-slot="button" className={linkButton}>
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

function KeyNumbers({ data, family }: { data: FamilyData; family: Family }) {
	const { alerts, records } = data;
	const hrv =
		records.kind === "ready" &&
		records.value.samples.some(
			(s) => s.familyId === family.id && s.metric === "hrv" && !s.synthetic,
		);
	return (
		<div className="grid gap-2 sm:grid-cols-2">
			{!hrv && (
				<div className="win95-inset grid gap-0.5 bg-card p-2">
					<span>HRV</span>
					<b className="text-muted-foreground text-xl">Unavailable</b>
					<span className="text-muted-foreground text-xs">
						No real reading stored
					</span>
				</div>
			)}
			<div className="win95-inset grid gap-0.5 bg-card p-2">
				<span>Open alerts</span>
				<b className="text-xl">
					{alerts.kind === "ready"
						? alerts.value.alerts.filter((a) => a.acknowledgements.length === 0)
								.length
						: "Unavailable"}
				</b>
				<span className="text-muted-foreground text-xs">
					Not seen by anyone yet
				</span>
			</div>
		</div>
	);
}

// Typed by the contract: a new source or status fails type-checking here until it has its words.
const sourceName = { noop: "WHOOP via NOOP" } satisfies Record<
	NoopConnection["source"],
	string
>;
const statusText = {
	not_connected: "Unavailable: not connected",
	connected: "Connected · readings unvalidated",
} satisfies Record<NoopConnection["status"], string>;

/** Every health source from `/api/sources`, as the server reports it. */
function SourceList({ sources }: { sources: Loaded<Sources> | undefined }) {
	if (sources === undefined || sources.kind === "error")
		return (
			<div className="win95-inset bg-card">
				<ApiNotice state={sources ?? { kind: "loading" }} what="sources" />
			</div>
		);
	return (
		<ul
			aria-label="Health sources"
			className="win95-inset grid divide-y divide-border bg-card"
		>
			{sources.value.sources.length === 0 && (
				<li className="p-2">No health source configured.</li>
			)}
			{sources.value.sources.map(({ source, status }) => (
				<li key={source} className="flex flex-wrap justify-between gap-x-2 p-2">
					<span>{sourceName[source]}</span>
					<span className="bg-[#ffffe1] px-1">{statusText[status]}</span>
				</li>
			))}
		</ul>
	);
}

/** The family's newest messages, read-only. Replying happens in the chat. */
function RecentMessages({
	data,
	familyId,
}: {
	data: FamilyData;
	familyId: string;
}) {
	const { records, me } = data;
	if (records.kind !== "ready")
		return (
			<div className="win95-inset bg-card">
				<ApiNotice state={records} what="messages" />
			</div>
		);
	const messages = records.value.messages
		.filter((m) => m.familyId === familyId)
		.toSorted((a, b) => b.sentAt.localeCompare(a.sentAt))
		.slice(0, 5);
	if (messages.length === 0)
		return <p className="win95-inset bg-card p-2">No messages yet.</p>;
	return (
		<ul className="win95-inset grid divide-y divide-border bg-card">
			{messages.map((m) => (
				<li key={m.id} className="grid gap-0.5 p-2">
					<span className="flex justify-between gap-2 text-xs">
						<b>{senderLabel(m, me)}</b>
						<time dateTime={m.sentAt}>{clock(m.sentAt)}</time>
					</span>
					<span className="line-clamp-2 break-words">{m.body}</span>
				</li>
			))}
		</ul>
	);
}

function RecentAlerts({ data }: { data: FamilyData }) {
	const { alerts } = data;
	if (alerts.kind !== "ready")
		return <ApiNotice state={alerts} what="alerts" />;
	if (alerts.value.alerts.length === 0)
		return <p className="p-2">No alerts recorded.</p>;
	return (
		<table className="w-full min-w-[34rem] border-collapse text-left">
			<thead className="sticky top-0 bg-background">
				<tr>
					{["Alert", "Time", "Delivery", "Seen"].map((h) => (
						<th key={h} className="win95-raised px-2 py-1 font-normal">
							{h}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{alerts.value.alerts.map((item) => (
					<AlertRow key={item.alert.id} item={item} me={data.me} />
				))}
			</tbody>
		</table>
	);
}

function AlertRow({ item, me }: { item: FamilyAlert; me: string | null }) {
	const failed =
		item.delivery?.status === "failed" ||
		item.delivery?.status === "unavailable";
	const ack = item.acknowledgements[0];
	return (
		<tr className="border-border border-b align-top">
			<td className="break-words px-2 py-1.5">{item.alert.summary}</td>
			<td className="whitespace-nowrap px-2 py-1.5">
				{clock(item.alert.createdAt)}
			</td>
			<td className={cn("px-2 py-1.5", failed && "font-bold text-destructive")}>
				{deliveryText(item.delivery)}
			</td>
			<td className="px-2 py-1.5">
				{ack === undefined
					? "Not yet"
					: `${memberLabel(ack.member, me)}, ${clock(ack.acknowledgedAt)}`}
			</td>
		</tr>
	);
}
