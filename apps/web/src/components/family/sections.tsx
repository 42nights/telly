// Family screen sections that came from the old dashboard: key numbers with the health sources, the
// newest messages, the alert history, and the alert thresholds.
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
import { cn } from "@health/ui/lib/utils";
import { useEffect, useState } from "react";

import { ApiNotice } from "@/components/win95";
import { ENV } from "@/env";
import type { ApiState } from "@/lib/api";
import { memberLabel, senderLabel } from "@/lib/members";

import type { FamilyData } from "./data";
import { clock, deliveryText, metricLabel } from "./logic";
import { ReadingsGlance } from "./parts";

export function KeyNumbers({
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
			<SourceList />
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
function SourceList() {
	const [sources, setSources] = useState<Loaded<Sources>>();
	useEffect(
		() =>
			loadDecoded(Sources, `${ENV.VITE_SERVER_URL}/api/sources`, setSources),
		[],
	);
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
export function RecentMessages({
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

export function RecentAlerts({ data }: { data: FamilyData }) {
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

export function Thresholds({
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
		<ul className="win95-inset divide-y divide-border bg-card">
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
