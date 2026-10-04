// The family screen's tables from the old dashboard (#209): the recent alerts and the alert
// thresholds. Each shows only what the server returned.
import type {
	AlertThreshold,
	FamilyAlert,
	Monitoring,
} from "@health/contracts/alerts";
import { cn } from "@health/ui/lib/utils";

import { ApiNotice } from "@/components/win95";
import type { ApiState } from "@/lib/api";
import { memberLabel } from "@/lib/members";
import { metricLabel } from "@/lib/readings";

import type { FamilyData } from "./data";
import { clock, deliveryText } from "./logic";

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

/** Each alert rule and its state now. A rule without a fresh reading is unavailable. */
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
										: `Unavailable: ${row.reason === "stale" ? "no recent reading" : "no reading"}`}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
