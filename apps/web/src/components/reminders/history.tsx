// The family's reminder history (#28): each due occurrence with every recorded step, in order, with
// who recorded it, from which device, and the person's own words.
import {
	type ReminderEvent,
	ReminderHistory,
	type ReminderState,
} from "@health/contracts/reminders";

import { ApiNotice } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";
import { memberLabel } from "@/lib/members";

const SHOWN = 10;

// "Seen" never reads as "done": only the two completion states say the task happened, and they say whose word it is.
const STATE_TEXT: Record<ReminderState, string> = {
	scheduled: "Scheduled",
	delivered: "Shown",
	acknowledged: "Seen, not done",
	self_reported_complete: "Done, by their own report",
	caregiver_confirmed: "Confirmed by a caregiver",
	deferred: "Put off",
	declined: "Declined",
	unresolved: "Unresolved",
};

const when = (iso: string) =>
	new Date(iso).toLocaleString([], {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

function EventLine({ event, me }: { event: ReminderEvent; me: string | null }) {
	const who =
		event.actor === "scheduler" ? "Scheduler" : memberLabel(event.actor, me);
	return (
		<li className="break-words">
			<time dateTime={event.at}>{when(event.at)}</time>
			{" · "}
			<b>{STATE_TEXT[event.state]}</b>
			{` · ${who}`}
			{event.source === "scheduler" ? "" : ` (${event.source})`}
			{event.wording === null ? "" : ` · “${event.wording}”`}
		</li>
	);
}

export function ReminderHistorySection({
	familyId,
	me,
}: {
	familyId: string;
	me: string | null;
}) {
	const state = useApi(
		ReminderHistory,
		familyPath(familyId, "/reminder-occurrences"),
		{ pollMs: 15_000 },
	);
	const now = Date.now();
	return (
		<section aria-labelledby="reminders" className="grid gap-2">
			<h3 id="reminders" className="font-bold">
				Reminders
			</h3>
			<div className="win95-inset grid gap-3 bg-card p-2">
				{state.kind !== "ready" ? (
					<ApiNotice state={state} what="reminders" />
				) : (
					<ReminderList
						occurrences={state.value.occurrences
							.filter((d) => Date.parse(d.occurrence.scheduledFor) <= now)
							.slice(0, SHOWN)}
						me={me}
					/>
				)}
			</div>
		</section>
	);
}

function ReminderList({
	occurrences,
	me,
}: {
	occurrences: ReminderHistory["occurrences"];
	me: string | null;
}) {
	if (occurrences.length === 0) return <p>No reminder has come due yet.</p>;
	return occurrences.map(({ occurrence, events }) => (
		<article key={occurrence.id} className="grid gap-1">
			<h4 className="font-bold">
				{occurrence.title}
				{" · "}
				<time dateTime={occurrence.scheduledFor}>
					{when(occurrence.scheduledFor)}
				</time>
				{" · "}
				{STATE_TEXT[occurrence.state]}
			</h4>
			<ol className="grid list-decimal gap-0.5 pl-6">
				{events.map((event) => (
					<EventLine key={event.id} event={event} me={me} />
				))}
			</ol>
		</article>
	));
}
