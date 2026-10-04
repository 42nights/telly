import {
	type Family,
	type Loaded,
	loadDecoded,
	type NoopConnection,
	Sources,
} from "@health/contracts";
import type {
	AlertThreshold,
	FamilyAlert,
	Monitoring,
} from "@health/contracts/alerts";
import { whoopCatalog } from "@health/contracts/whoop-catalog";
import { buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	Bell,
	FileText,
	House,
	LayoutDashboard,
	MessageCircle,
	SlidersHorizontal,
	TrendingUp,
} from "lucide-react";
import { useEffect, useState } from "react";

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
import { ENV } from "@/env";
import type { ApiState } from "@/lib/api";
import { PersonPicker } from "@/lib/family";
import { memberLabel, senderLabel } from "@/lib/members";

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
							{(family) => (
								<DashboardBody key={family.id} data={data} family={family} />
							)}
						</FamilyGate>
						<WhoopCatalog />
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
			<Link to="/trends" className={navClass}>
				<TrendingUp aria-hidden className="size-4" /> Trends
			</Link>
			<a href="#thresholds" className={navClass}>
				<SlidersHorizontal aria-hidden className="size-4" /> Thresholds
			</a>
		</nav>
	);
}

function DashboardBody({ data, family }: { data: FamilyData; family: Family }) {
	const now = Date.now();
	const [sources, setSources] = useState<Loaded<Sources>>();
	useEffect(
		() =>
			loadDecoded(Sources, `${ENV.VITE_SERVER_URL}/api/sources`, setSources),
		[],
	);
	return (
		<>
			<AlertSection data={data} now={now} />
			<KeyNumbers data={data} family={family} now={now} sources={sources} />
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
			<section
				id="messages"
				aria-labelledby="messages-title"
				className="grid content-start gap-2"
			>
				<h3 id="messages-title" className="font-bold">
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
		</>
	);
}

function KeyNumbers({
	data,
	family,
	now,
	sources,
}: {
	data: FamilyData;
	family: Family;
	now: number;
	sources: Loaded<Sources> | undefined;
}) {
	const { alerts, records } = data;
	const hrv =
		records.kind === "ready" &&
		records.value.samples.some(
			(s) => s.familyId === family.id && s.metric === "hrv" && !s.synthetic,
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
							No real reading stored
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
			<SourceList sources={sources} />
		</section>
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

function WhoopCatalog() {
	return (
		<details className="win95-inset bg-card">
			<summary className="min-h-11 cursor-pointer p-2 font-bold">
				WHOOP fields from Healer S.I. · placeholders, not readings
			</summary>
			<p className="px-2 pb-2 text-muted-foreground text-xs">
				Value shows {"{type}"} then the unit, or why the field is unavailable.
				Kind gives each field's status and validation.
			</p>
			<div className="h-96 overflow-auto">
				<table className="w-full min-w-[64rem] border-collapse text-left">
					<thead className="sticky top-0 bg-background">
						<tr>
							{[
								"Field",
								"Value",
								"Kind",
								"Cadence",
								"Delivery",
								"Device",
								"Recorded as",
							].map((h) => (
								<th key={h} className="win95-raised px-2 py-1 font-normal">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{whoopCatalog.map((f) => (
							<tr
								key={`${f.table}.${f.column}`}
								className="border-border border-b align-top"
							>
								<td className="break-all px-2 py-1.5">
									<code>
										{f.table}.{f.column}
									</code>
								</td>
								<td
									className={cn(
										"px-2 py-1.5",
										f.unavailable !== null && "bg-[#ffffe1]",
									)}
								>
									{f.unavailable === null
										? `{${f.type}}${f.unit === null ? "" : ` ${f.unit}`}`
										: `unavailable: ${f.unavailable}`}
								</td>
								<td className="px-2 py-1.5">
									{f.status} · {f.validation.replaceAll("_", " ")}
								</td>
								<td className="px-2 py-1.5">{f.cadence}</td>
								<td className="px-2 py-1.5">{f.delay}</td>
								<td className="px-2 py-1.5">{f.device}</td>
								<td className="px-2 py-1.5">{f.metric ?? "not recorded"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</details>
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
