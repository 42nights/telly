// The wearer's open reminders (#28). This screen gives each due prompt once and records that it was
// shown. No glasses state reaches the app, so this screen never hands a prompt to the home speaker
// (#46); the bedtime screen does, because the glasses are off at bedtime.
import {
	ReminderHistory,
	ReminderOccurrenceDetail,
	type ReminderResponse,
} from "@health/contracts/reminders";
import { Button } from "@health/ui/components/button";
import { useEffect, useRef, useState } from "react";

import { ApiNotice } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";

import { STATE_TEXT } from "./history";

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
	const [notes, setNotes] = useState<Record<string, string>>({});
	const given = useRef(new Set<string>());

	useEffect(() => {
		if (base === null || history.kind !== "ready") return;
		const give = async (id: string, clientId: string) => {
			await apiRequest(
				ReminderOccurrenceDetail,
				`${base}/${encodeURIComponent(id)}/deliveries`,
				{ method: "POST", body: { clientId, source: "web" } },
			);
			setRefreshKey((k) => k + 1);
		};
		for (const { occurrence, events } of history.value.occurrences) {
			if (!occurrence.promptDue) continue;
			// The same id on every retry of this prompt, so the server records it once.
			const clientId = `w-${occurrence.id}-${events.length}`;
			if (given.current.has(clientId)) continue;
			given.current.add(clientId);
			void give(occurrence.id, clientId);
		}
	}, [base, history]);

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
