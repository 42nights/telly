// The Home "Today" box (#308): the next reminder and the alerts the wearer has not seen, one line
// each. The full reminders and alerts come to the wearer's phone as texts.
import type { FamilyRecords } from "@health/contracts";
import { Me } from "@health/contracts/families";
import {
	ReminderHistory,
	type ReminderOccurrence,
} from "@health/contracts/reminders";
import { BellRing, TriangleAlert } from "lucide-react";

import { ago } from "@/components/family/logic";
import { TextTellyButton } from "@/components/text-telly";
import { ApiNotice } from "@/components/win95";
import { type ApiState, familyPath, useApi } from "@/lib/api";

/** At most this many alert lines; the rest show as a count. */
const ALERTS_SHOWN = 3;

/** The soonest occurrence that is still to come, or null. */
const nextReminder = (history: ReminderHistory, now: number) =>
	history.occurrences
		.map((o) => o.occurrence)
		.filter((o) => o.state === "scheduled" && Date.parse(o.scheduledFor) >= now)
		.reduce<ReminderOccurrence | null>(
			(soonest, o) =>
				soonest === null || o.scheduledFor < soonest.scheduledFor ? o : soonest,
			null,
		);

const at = (iso: string, now: number) => {
	const time = new Date(iso);
	const clock = time.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
	return time.toDateString() === new Date(now).toDateString()
		? clock
		: `${time.toLocaleDateString([], { weekday: "long" })} ${clock}`;
};

function NextReminder({ familyId, now }: { familyId: string; now: number }) {
	const history = useApi(
		ReminderHistory,
		familyPath(familyId, "/reminder-occurrences"),
		{ pollMs: 60_000 },
	);
	if (history.kind !== "ready")
		return <ApiNotice state={history} what="reminders" />;
	const next = nextReminder(history.value, now);
	return (
		<p className="flex items-center gap-2">
			<BellRing aria-hidden className="size-5 shrink-0" />
			{next === null ? (
				"No reminder is coming up."
			) : (
				<span className="min-w-0 truncate">
					Next: <b>{next.title}</b> at {at(next.scheduledFor, now)}
				</span>
			)}
		</p>
	);
}

/** The family's alerts that I have not marked as seen, newest first. */
function Alerts({
	records,
	familyId,
	now,
}: {
	records: FamilyRecords;
	familyId: string;
	now: number;
}) {
	const me = useApi(Me, "/api/me");
	const identity = me.kind === "ready" ? me.value.identity : null;
	const seen = new Set(
		records.acknowledgements
			.filter((a) => a.member === identity)
			.map((a) => a.alertId),
	);
	const unseen = records.alerts
		.filter((a) => a.familyId === familyId && !seen.has(a.id))
		.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
	const more = unseen.length - ALERTS_SHOWN;
	return (
		<>
			{unseen.slice(0, ALERTS_SHOWN).map((alert) => (
				<p className="flex items-start gap-2" key={alert.id}>
					<TriangleAlert
						aria-hidden
						className="mt-1 size-5 shrink-0 text-destructive"
					/>
					<span className="min-w-0 break-words">
						<b>{alert.summary}</b> · {ago(alert.createdAt, now)}
					</span>
				</p>
			))}
			{more > 0 && (
				<p className="pl-7">
					{more} more {more === 1 ? "alert" : "alerts"}.
				</p>
			)}
		</>
	);
}

export function Today({
	familyId,
	records,
	now,
}: {
	familyId: string | null;
	records: ApiState<FamilyRecords> | null;
	now: number;
}) {
	return (
		<section
			aria-labelledby="today"
			className="win95-inset grid min-h-0 grid-cols-1 content-start gap-1 overflow-y-auto bg-card p-2 text-[18px] md:p-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
				<h2 className="font-bold text-[20px]" id="today">
					Today ·{" "}
					{new Date(now).toLocaleDateString([], {
						weekday: "long",
						day: "numeric",
						month: "long",
					})}
				</h2>
				<TextTellyButton className="text-[16px]" />
			</div>
			{familyId !== null && <NextReminder familyId={familyId} now={now} />}
			{familyId !== null && records?.kind === "ready" && (
				<Alerts familyId={familyId} now={now} records={records.value} />
			)}
			<p className="text-[16px] text-muted-foreground">
				Reminders and alerts come to your phone as texts.
			</p>
		</section>
	);
}
