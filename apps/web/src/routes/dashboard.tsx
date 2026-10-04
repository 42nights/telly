import type { Family } from "@health/contracts";
import type {
	AlertThreshold,
	FamilyAlert,
	Monitoring,
} from "@health/contracts/alerts";
import { cn } from "@health/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	Bell,
	FileText,
	House,
	LayoutDashboard,
	MessageCircle,
	SlidersHorizontal,
} from "lucide-react";

import { type FamilyData, useFamilyData } from "@/components/family/data";
import { clock, deliveryText, metricLabel } from "@/components/family/logic";
import {
	AlertSection,
	FamilyGate,
	MonitoringBadge,
	ReadingsGlance,
} from "@/components/family/parts";
import { Window } from "@/components/hud/window";
import { ApiNotice, Tip } from "@/components/win95";
import type { ApiState } from "@/lib/api";
import { PersonPicker } from "@/lib/family";
import { memberLabel } from "@/lib/members";

export const Route = createFileRoute("/dashboard")({
	component: Dashboard,
});

const navClass =
	"flex min-h-11 items-center gap-2 px-3 text-sm hover:bg-primary hover:text-primary-foreground focus-visible:outline-dotted";

function Dashboard() {
	const data = useFamilyData();
	return (
		<main className="win95-desktop min-h-0 overflow-y-auto p-2 sm:p-4">
			<Window
				title="Family dashboard"
				icon={LayoutDashboard}
				className="mx-auto w-full max-w-6xl"
			>
				<div className="grid grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-[12rem_minmax(0,1fr)]">
					<DashboardNav />
					<div
						id="overview"
						className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-1 text-sm"
					>
						<header className="flex flex-wrap items-center gap-x-3 gap-y-2">
							<h2 className="font-bold text-2xl">
								{data.family?.name ?? "No person"}
							</h2>
							{data.family !== null && (
								<MonitoringBadge state={data.monitoring} />
							)}
							<PersonPicker className="ml-auto max-w-full [&_select]:min-w-0 [&_select]:flex-1" />
						</header>
						<FamilyGate data={data} emptyClassName="win95-inset bg-card p-3">
							{(family) => <DashboardBody data={data} family={family} />}
						</FamilyGate>
					</div>
				</div>
			</Window>
		</main>
	);
}

function DashboardNav() {
	return (
		<nav
			aria-label="Dashboard"
			className="win95-inset flex flex-wrap content-start bg-card md:flex-col md:flex-nowrap"
		>
			<a href="#overview" className={navClass}>
				<House aria-hidden className="size-4" /> Overview
			</a>
			<a href="#alerts" className={navClass}>
				<Bell aria-hidden className="size-4" /> Alerts
			</a>
			<Link to="/chat" className={navClass}>
				<MessageCircle aria-hidden className="size-4" /> Ask
			</Link>
			<Link to="/reports" className={navClass}>
				<FileText aria-hidden className="size-4" /> Reports
			</Link>
			<a href="#thresholds" className={navClass}>
				<SlidersHorizontal aria-hidden className="size-4" /> Thresholds
			</a>
		</nav>
	);
}

function DashboardBody({ data, family }: { data: FamilyData; family: Family }) {
	const now = Date.now();
	return (
		<>
			<AlertSection data={data} now={now} />
			<KeyNumbers data={data} family={family} now={now} />
			<div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<section
					id="alerts"
					aria-labelledby="recent"
					className="grid content-start gap-2"
				>
					<h3 id="recent" className="font-bold">
						Recent alerts
					</h3>
					<div className="win95-inset h-64 overflow-auto bg-card">
						<RecentAlerts data={data} />
					</div>
				</section>

				<section
					id="thresholds"
					aria-labelledby="thresholds-title"
					className="grid content-start gap-2"
				>
					<h3
						id="thresholds-title"
						className="flex items-center gap-1 font-bold"
					>
						Alert thresholds
						<Tip
							align="end"
							text="Read-only here. A rule without a fresh validated reading shows as unavailable, never as passing."
						/>
					</h3>
					<Thresholds state={data.thresholds} monitoring={data.monitoring} />
				</section>
			</div>
		</>
	);
}

function KeyNumbers({
	data,
	family,
	now,
}: {
	data: FamilyData;
	family: Family;
	now: number;
}) {
	const { alerts, records } = data;
	const hrv =
		records.kind === "ready" &&
		records.value.samples.some(
			(s) => s.familyId === family.id && s.metric === "hrv",
		);
	return (
		<section aria-labelledby="numbers" className="grid gap-2">
			<h3 id="numbers" className="font-bold">
				Key numbers
			</h3>
			<div className="grid gap-2 sm:grid-cols-2">
				{!hrv && (
					<div className="win95-inset grid gap-0.5 bg-card p-2">
						<span>HRV</span>
						<b className="text-muted-foreground text-xl">Unavailable</b>
						<span className="text-muted-foreground text-xs">
							WHOOP · NOOP not connected
						</span>
					</div>
				)}
				<div className="win95-inset grid gap-0.5 bg-card p-2">
					<span>Open alerts</span>
					<b className="text-xl">
						{alerts.kind === "ready"
							? alerts.value.alerts.filter(
									(a) => a.acknowledgements.length === 0,
								).length
							: "Unavailable"}
					</b>
					<span className="text-muted-foreground text-xs">
						Not seen by anyone yet
					</span>
				</div>
			</div>
			<ReadingsGlance data={data} familyId={family.id} now={now} />
		</section>
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

function Thresholds({
	state,
	monitoring,
}: {
	state: ApiState<{ readonly thresholds: readonly AlertThreshold[] }>;
	monitoring: ApiState<Monitoring>;
}) {
	if (state.kind !== "ready")
		return <ApiNotice state={state} what="thresholds" />;
	if (state.value.thresholds.length === 0)
		return (
			<p className="win95-inset bg-card p-2">
				No thresholds set: nothing is monitored.
			</p>
		);
	return (
		<ul className="win95-inset h-64 divide-y divide-border overflow-auto bg-card">
			{state.value.thresholds.map((t) => {
				const row =
					monitoring.kind === "ready"
						? monitoring.value.thresholds.find((m) => m.threshold.id === t.id)
						: undefined;
				return (
					<li key={t.id} className="flex flex-wrap justify-between gap-x-2 p-2">
						<span>
							{metricLabel(t.metric)} {t.direction} {t.limit} {t.unit}
						</span>
						<span
							className={cn(
								row?.state === "out_of_range" && "font-bold text-destructive",
								(row === undefined || row.state === "unavailable") &&
									"bg-[#ffffe1] px-1",
							)}
						>
							{row === undefined
								? "State unknown"
								: row.state === "in_range"
									? "In range"
									: row.state === "out_of_range"
										? "Out of range"
										: `Unavailable: ${row.reason === "stale" ? "stale reading" : "no validated reading"}`}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
