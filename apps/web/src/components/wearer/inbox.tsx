// Home's right column: due reminders, then alerts and messages for the selected person.
import type { FamilyRecords } from "@health/contracts";

import { Alerts } from "@/components/hud/alerts";
import { DueReminders } from "@/components/reminders/due-reminders";
import type { ApiState } from "@/lib/api";

import { Messages } from "./messages";

export function WearerInbox({
	familyId,
	now,
	records,
}: {
	familyId: string | null;
	now: number;
	/** Null when no person is paired. */
	records: ApiState<FamilyRecords> | null;
}) {
	return (
		<section
			aria-label="Reminders, alerts, and messages"
			className="grid min-w-0 content-start gap-2 md:row-span-2"
		>
			<DueReminders familyId={familyId} />
			<h2 className="font-bold text-[16px]">Alerts</h2>
			{records === null ? (
				<p className="win95-inset bg-card p-3 text-[18px]">
					No person is paired yet, so there are no alerts.
				</p>
			) : (
				<Alerts familyId={familyId} now={now} records={records} />
			)}
			<h2 className="font-bold text-[16px]">Messages</h2>
			{records === null ? (
				<p className="win95-inset bg-card p-3 text-[18px]">
					No person is paired yet, so there are no messages.
				</p>
			) : (
				<Messages familyId={familyId} records={records} />
			)}
		</section>
	);
}
