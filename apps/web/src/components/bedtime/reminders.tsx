// Overnight reminders on the bedtime screen: the saved #28 lifecycle only. The database schedules and
// repeats every prompt, so taking the glasses off or closing them changes nothing; this screen shows
// a due prompt, records that it was shown, and records the wearer's answer.
import {
	ReminderHistory,
	type ReminderOccurrence,
	ReminderOccurrenceDetail,
	type ReminderResponse,
	SavedReminderSettings,
} from "@health/contracts/reminders";
import { Button } from "@health/ui/components/button";
import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiNotice } from "@/components/win95";
import { type ApiState, apiRequest, familyPath, useApi } from "@/lib/api";
import { ANSWERED, awaitsAnswer, fallbackText, tonight } from "./logic";

const POLL_MS = 10_000;

const ANSWERS: readonly { response: ReminderResponse; label: string }[] = [
	{ response: "okay", label: "Okay, I see it" },
	{ response: "done", label: "I did it" },
	{ response: "later", label: "Later" },
	{ response: "help", label: "I need help" },
];

function DuePrompt({
	familyId,
	occurrence,
	onAnswered,
}: {
	familyId: string;
	occurrence: ReminderOccurrence;
	onAnswered: (text: string) => void;
}) {
	const [problem, setProblem] = useState<string | null>(null);
	const answer = async (response: ReminderResponse) => {
		const result = await apiRequest(
			ReminderOccurrenceDetail,
			familyPath(familyId, `/reminder-occurrences/${occurrence.id}/answers`),
			{
				method: "POST",
				body: {
					clientId: crypto.randomUUID(),
					source: "web",
					response,
					wording: null,
				},
			},
		);
		if (result.kind !== "ready")
			return setProblem(
				result.kind === "signed_out"
					? "Sign in again to answer."
					: `Not saved: ${result.message}`,
			);
		onAnswered(
			ANSWERED[result.value.occurrence.state] ??
				"Saved. I will ask again soon.",
		);
	};
	return (
		<div className="win95-raised grid gap-3 p-3" role="alert">
			<p className="flex items-center gap-2 font-semibold text-[24px]">
				<BellRing aria-hidden className="size-7 shrink-0" />
				{occurrence.title}
			</p>
			<div className="grid grid-cols-2 gap-2">
				{ANSWERS.map(({ response, label }) => (
					<Button
						key={response}
						className="h-14 text-[20px]"
						variant={response === "okay" ? "default" : "outline"}
						onClick={() => void answer(response)}
					>
						{label}
					</Button>
				))}
			</div>
			<p className="text-[16px]">
				"Okay" only says you saw it. Press "I did it" when it is done.
			</p>
			{problem !== null && (
				<p className="text-[16px] text-destructive">{problem}</p>
			)}
		</div>
	);
}

/** Tonight's saved reminders and what happens when one goes unanswered. */
function Tonight({
	occurrences,
	settings,
}: {
	occurrences: readonly ReminderOccurrence[];
	settings: ApiState<SavedReminderSettings>;
}) {
	const upcoming = tonight(occurrences, Date.now());
	return (
		<>
			{upcoming.length === 0 ? (
				<p>No saved reminder is due tonight, so nothing will wake you.</p>
			) : (
				<ul className="grid gap-1">
					{upcoming.map(({ id, text }) => (
						<li key={id}>{text}</li>
					))}
				</ul>
			)}
			<p className="text-[16px]">
				Saved reminders only, from your family. Keep this screen open and the
				phone plugged in: a closed tab cannot wake you.{" "}
				{settings.kind === "ready" && settings.value.settings !== null
					? fallbackText(settings.value.settings)
					: "Nobody calls 911 when a reminder goes unanswered."}
			</p>
		</>
	);
}

/** Saved reminders for tonight and any prompt due now. `onPrompt` runs once per new prompt. */
export function OvernightReminders({
	familyId,
	onPrompt,
}: {
	familyId: string | null;
	onPrompt: () => void;
}) {
	const [refresh, setRefresh] = useState(0);
	const [answered, setAnswered] = useState<string | null>(null);
	const path = familyId === null ? null : familyPath(familyId, "");
	const history = useApi(
		ReminderHistory,
		path === null ? null : `${path}/reminder-occurrences`,
		{ pollMs: POLL_MS, refreshKey: refresh },
	);
	const settings = useApi(
		SavedReminderSettings,
		path === null ? null : `${path}/reminder-settings`,
	);
	const occurrences =
		history.kind === "ready"
			? history.value.occurrences.map((d) => d.occurrence)
			: [];
	// One prompt at a time. Only the prompt on screen is recorded as delivered.
	const showing = occurrences.find(awaitsAnswer);
	const freshKey =
		showing?.promptDue === true ? `${showing.id}-${showing.prompts}` : null;

	// A new prompt: sound it, then record that this device showed it. The id is the same on a resend,
	// so a retried delivery records one event.
	useEffect(() => {
		if (freshKey === null || familyId === null) return;
		const [occurrenceId] = freshKey.split("-");
		onPrompt();
		setAnswered(null);
		void apiRequest(
			ReminderOccurrenceDetail,
			familyPath(familyId, `/reminder-occurrences/${occurrenceId}/deliveries`),
			{
				method: "POST",
				body: { clientId: `bedtime-${freshKey}`, source: "web" },
			},
		).then(() => setRefresh((n) => n + 1));
	}, [freshKey, familyId, onPrompt]);

	if (familyId === null)
		return <ApiNotice state={{ kind: "signed_out" }} what="reminders" />;
	if (history.kind !== "ready")
		return <ApiNotice state={history} what="reminders" />;
	return (
		<div className="grid gap-2 text-[18px]">
			{showing !== undefined && (
				<DuePrompt
					key={showing.id}
					familyId={familyId}
					occurrence={showing}
					onAnswered={(text) => {
						setAnswered(text);
						setRefresh((n) => n + 1);
					}}
				/>
			)}
			{answered !== null && (
				<p className="win95-inset bg-card p-2" role="status">
					{answered}
				</p>
			)}
			<Tonight occurrences={occurrences} settings={settings} />
		</div>
	);
}
