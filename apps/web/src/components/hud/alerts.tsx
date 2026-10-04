import type { FamilyRecords } from "@health/contracts";
import { TriangleAlert } from "lucide-react";

import { ago } from "@/components/wearer/logic";
import { ApiNotice } from "@/components/win95";
import type { ApiState } from "@/lib/api";

/**
 * The family's alerts, newest first, read-only: family members mark them as seen on their own
 * screens. No alert is never shown as "all clear"; the monitoring chip says what is watched.
 */
export function Alerts({
	records,
	familyId,
	now,
}: {
	records: ApiState<FamilyRecords>;
	familyId: string | null;
	now: number;
}) {
	if (records.kind !== "ready")
		return (
			<div className="win95-inset bg-card">
				<ApiNotice state={records} what="alerts" />
			</div>
		);
	const seen = new Set(
		records.value.acknowledgements.map(({ alertId }) => alertId),
	);
	const alerts = records.value.alerts
		.filter((alert) => alert.familyId === familyId)
		.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
	if (alerts.length === 0)
		return (
			<p className="win95-inset bg-card p-3 text-[18px]" role="status">
				No alerts recorded. This is not an all-clear: see Monitoring below.
			</p>
		);
	return (
		<ul className="win95-inset grid max-h-[16rem] content-start gap-2 overflow-y-auto bg-card p-2">
			{alerts.map((alert) => (
				<li
					className="win95-raised grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-l-4 border-l-destructive px-3 py-2"
					key={alert.id}
				>
					<TriangleAlert aria-hidden className="mt-1 size-5 text-destructive" />
					<p className="break-words font-bold text-[20px]">{alert.summary}</p>
					<p className="col-start-2 text-[15px]">
						<time dateTime={alert.createdAt}>
							{ago(now - Date.parse(alert.createdAt))}
						</time>
						{" · "}
						{seen.has(alert.id) ? "Seen by family" : "Not seen yet"}
					</p>
				</li>
			))}
		</ul>
	);
}
