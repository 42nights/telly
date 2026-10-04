// The wearer's open reminders (#28) with the home-speaker handoff (#46). This screen gives each due
// prompt once: while the glasses charge it first asks the home speaker. When the speaker is off,
// offline, or refuses, the prompt is shown here instead. A prompt the speaker said is shown here
// without a second announcement, so the wearer can still answer it.
import {
	ReminderHistory,
	ReminderOccurrenceDetail,
	type ReminderResponse,
} from "@health/contracts/reminders";
import { SpeakerHandoff } from "@health/contracts/speaker";
import { Button } from "@health/ui/components/button";
import { useEffect, useRef, useState } from "react";

import { ApiNotice } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";

import { STATE_TEXT } from "./history";

const REASON_TEXT: Record<NonNullable<SpeakerHandoff["reason"]>, string> = {
	disabled: "The home speaker is off",
	offline: "The home speaker is offline",
	refused: "The home speaker refused it",
};

const ANSWERS: readonly [ReminderResponse, string][] = [
	["okay", "Okay"],
	["done", "Done"],
	["later", "Later"],
];

export function DueReminders({ familyId }: { familyId: string | null }) {
	const base =
		familyId === null ? null : familyPath(familyId, "/reminder-occurrences");
	const [refreshKey, setRefreshKey] = useState(0);
	const history = useApi(ReminderHistory, base, {
		pollMs: 15_000,
		refreshKey,
	});
	// No glasses state reaches the app yet, so the wearer sets it here for the demonstration.
	const [charging, setCharging] = useState(false);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const given = useRef(new Set<string>());

	useEffect(() => {
		if (base === null || history.kind !== "ready") return;
		const refresh = () => setRefreshKey((k) => k + 1);
		const give = async (id: string, clientId: string) => {
			const path = `${base}/${encodeURIComponent(id)}`;
			if (charging) {
				const handoff = await apiRequest(
					SpeakerHandoff,
					`${path}/speaker-handoffs`,
					{ method: "POST", body: { clientId } },
				);
				if (handoff.kind === "ready" && handoff.value.outcome !== "use_phone")
					return refresh();
				const why =
					handoff.kind === "ready" && handoff.value.reason !== null
						? REASON_TEXT[handoff.value.reason]
						: "The home speaker could not be reached";
				setNotes((n) => ({ ...n, [id]: `${why}, so it is shown here.` }));
			}
			await apiRequest(ReminderOccurrenceDetail, `${path}/deliveries`, {
				method: "POST",
				body: { clientId, source: "web" },
			});
			refresh();
		};
		for (const { occurrence, events } of history.value.occurrences) {
			if (!occurrence.promptDue) continue;
			// The same id on every retry of this prompt, so the server records it once.
			const clientId = `w-${occurrence.id}-${events.length}`;
			if (given.current.has(clientId)) continue;
			given.current.add(clientId);
			void give(occurrence.id, clientId);
		}
	}, [base, history, charging]);

	if (base === null) return null;
	const answer = async (
		detail: ReminderOccurrenceDetail,
		response: ReminderResponse,
	) => {
		const { id } = detail.occurrence;
		const result = await apiRequest(
			ReminderOccurrenceDetail,
			`${base}/${encodeURIComponent(id)}/answers`,
			{
				method: "POST",
				body: {
					// Stable for this answer to this state, so a double tap records it once.
					clientId: `a-${id}-${response}-${detail.events.length}`,
					source: "web",
					response,
					wording: null,
				},
			},
		);
		if (result.kind !== "ready")
			setNotes((n) => ({
				...n,
				[id]:
					result.kind === "signed_out"
						? "Sign in to answer."
						: `Not saved: ${result.message}`,
			}));
		setRefreshKey((k) => k + 1);
	};
	const open =
		history.kind === "ready"
			? history.value.occurrences.filter(
					({ occurrence: o }) =>
						o.promptDue ||
						(o.nextPromptAt !== null &&
							(o.state === "delivered" || o.state === "acknowledged")),
				)
			: [];

	return (
		<section aria-labelledby="due-reminders" className="grid gap-2">
			<h2 id="due-reminders" className="font-bold text-[16px]">
				Reminders
			</h2>
			<label className="flex min-h-11 items-center gap-2">
				<input
					type="checkbox"
					checked={charging}
					onChange={(e) => setCharging(e.target.checked)}
				/>
				My glasses are charging (simulated)
			</label>
			{history.kind !== "ready" ? (
				<ApiNotice state={history} what="reminders" />
			) : open.length === 0 ? (
				<p className="win95-inset bg-card p-3 text-[18px]">
					No reminder is due.
				</p>
			) : (
				<ul aria-live="polite" className="grid gap-2">
					{open.map((detail) => {
						const { occurrence } = detail;
						const spoken =
							detail.events.findLast((e) => e.state === "delivered")?.source ===
							"speaker";
						return (
							<li
								key={occurrence.id}
								className="win95-inset grid gap-2 bg-card p-3 text-[18px]"
							>
								<b className="break-words">{occurrence.title}</b>
								<span className="text-sm">
									{STATE_TEXT[occurrence.state]}
									{spoken ? " · Said on the home speaker." : ""}
									{notes[occurrence.id] === undefined
										? ""
										: ` · ${notes[occurrence.id]}`}
								</span>
								<div className="flex flex-wrap gap-2">
									{ANSWERS.map(([response, label]) => (
										<Button
											key={response}
											type="button"
											className="h-11 px-4"
											onClick={() => void answer(detail, response)}
										>
											{label}
										</Button>
									))}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
