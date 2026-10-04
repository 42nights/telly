// Meal and drink check-ins for the family (#32): whether a device showed each one, whether the
// wearer said they ate or drank, and whether it is unresolved, as three separate facts.
import { ReminderHistory } from "@health/contracts/reminders";

import { ApiNotice } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";

import { familyStatus, isMealKind } from "./logic";

const SHOWN = 6;

const when = (iso: string) =>
	new Date(iso).toLocaleString([], {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

function Fact({ label, at }: { label: string; at: string | null }) {
	return (
		<li>
			{label}: {at === null ? <b>no</b> : <b>yes</b>}
			{at !== null && (
				<>
					{" · "}
					<time dateTime={at}>{when(at)}</time>
				</>
			)}
		</li>
	);
}

export function MealStatusSection({ familyId }: { familyId: string }) {
	const state = useApi(
		ReminderHistory,
		familyPath(familyId, "/reminder-occurrences"),
		{ pollMs: 15_000 },
	);
	const now = Date.now();
	const due =
		state.kind === "ready"
			? state.value.occurrences
					.filter(
						({ occurrence: o }) =>
							isMealKind(o.kind) && Date.parse(o.scheduledFor) <= now,
					)
					.slice(0, SHOWN)
			: [];
	return (
		<section aria-labelledby="meals" className="grid gap-2">
			<h3 id="meals" className="font-bold">
				Meals and drinks
			</h3>
			<div className="win95-inset grid gap-3 bg-card p-2">
				{state.kind !== "ready" ? (
					<ApiNotice state={state} what="meal check-ins" />
				) : due.length === 0 ? (
					<p>No meal or drink check-in has come due yet.</p>
				) : (
					<>
						<p className="text-muted-foreground">
							“Says they did” is the person's own report. It does not show how
							much they ate or drank, or that they are well.
						</p>
						{due.map(({ occurrence, events }) => {
							const s = familyStatus(events);
							return (
								<article className="grid gap-1" key={occurrence.id}>
									<h4 className="font-bold">
										{occurrence.title}
										{" · "}
										<time dateTime={occurrence.scheduledFor}>
											{when(occurrence.scheduledFor)}
										</time>
									</h4>
									<ul className="grid gap-0.5 pl-2">
										<Fact
											at={s.delivered?.at ?? null}
											label="Shown on a device"
										/>
										<Fact
											at={s.selfReported?.at ?? null}
											label="Says they did"
										/>
										{s.caregiverConfirmed !== null && (
											<Fact
												at={s.caregiverConfirmed.at}
												label="Confirmed by a caregiver"
											/>
										)}
										<Fact at={s.unresolved?.at ?? null} label="Unresolved" />
										{s.wording !== null && (
											<li className="break-words">
												Their words: “{s.wording}”
											</li>
										)}
									</ul>
								</article>
							);
						})}
					</>
				)}
			</div>
		</section>
	);
}
