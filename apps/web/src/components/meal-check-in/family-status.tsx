// Meal and drink check-ins for the family (#32): the reminder times a family member sets, and for
// each check-in whether a device showed it, whether the wearer said they ate or drank, and whether
// it is unresolved, as three separate facts.
import {
	Reminder,
	ReminderHistory,
	Reminders,
	SavedReminderSettings,
} from "@health/contracts/reminders";
import { Button } from "@health/ui/components/button";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { failureText } from "@/components/chat/logic";
import { ApiNotice } from "@/components/win95";
import { type ApiState, apiRequest, familyPath, useApi } from "@/lib/api";

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

const field = "win95-inset win95-field h-11 min-w-0 bg-card px-2 text-sm";
const MAX_TIMES = 12;

type Time = { readonly id: string; readonly value: string };
const newTime = (): Time => ({ id: crypto.randomUUID(), value: "" });

/** One `<input type="time">` per reminder time, and "Add another time" up to `MAX_TIMES`. */
function TimeFields({
	times,
	onChange,
}: {
	times: readonly Time[];
	onChange: (times: readonly Time[]) => void;
}) {
	return (
		<fieldset className="flex flex-wrap items-end gap-1">
			<legend className="mb-1">Times</legend>
			{times.map((time, index) => (
				<input
					aria-label={`Time ${index + 1}`}
					className={field}
					key={time.id}
					onChange={(e) =>
						onChange(
							times.map((t) =>
								t.id === time.id ? { ...t, value: e.target.value } : t,
							),
						)
					}
					required={index === 0}
					type="time"
					value={time.value}
				/>
			))}
			{times.length < MAX_TIMES && (
				<Button
					className="h-11"
					onClick={() => onChange([...times, newTime()])}
					type="button"
				>
					<Plus aria-hidden />
					Add another time
				</Button>
			)}
		</fieldset>
	);
}

/** The saved meal and drink reminders, each with Delete. */
function ReminderList({
	reminders,
	onDelete,
}: {
	reminders: ApiState<Reminders>;
	onDelete: (reminder: Reminder) => Promise<void>;
}) {
	if (reminders.kind !== "ready")
		return <ApiNotice state={reminders} what="reminders" />;
	const meals = reminders.value.reminders.filter((r) => isMealKind(r.kind));
	if (meals.length === 0)
		return (
			<p className="text-muted-foreground">No meal or drink reminder is set.</p>
		);
	return (
		<ul className="grid gap-1">
			{meals.map((reminder) => (
				<li className="flex items-center gap-2" key={reminder.id}>
					<span className="min-w-0 flex-1 break-words">
						<b>{reminder.title}</b> · {reminder.times.join(", ")}
					</span>
					<Button
						aria-label={`Delete ${reminder.title}`}
						onClick={() => void onDelete(reminder)}
						type="button"
					>
						<Trash2 aria-hidden />
						Delete
					</Button>
				</li>
			))}
		</ul>
	);
}

/** The family's meal and drink reminders: the list with Delete, and a form to add one. */
function MealReminders({ familyId }: { familyId: string }) {
	const [refresh, setRefresh] = useState(0);
	const reminders = useApi(Reminders, familyPath(familyId, "/reminders"), {
		refreshKey: refresh,
	});
	const settings = useApi(
		SavedReminderSettings,
		familyPath(familyId, "/reminder-settings"),
		{ refreshKey: refresh },
	);
	const [title, setTitle] = useState("");
	const [kind, setKind] = useState<"meal" | "hydration">("meal");
	const [times, setTimes] = useState<readonly Time[]>(() => [newTime()]);
	const [status, setStatus] = useState<string | null>(null);
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const noSettings =
		settings.kind === "ready" && settings.value.settings === null;

	const save = async () => {
		setStatus("Saving…");
		if (noSettings) {
			const saved = await apiRequest(
				null,
				familyPath(familyId, "/reminder-settings"),
				{
					method: "PUT",
					body: {
						timeZone: zone,
						quietHours: null,
						repeatEveryMinutes: 10,
						maxPrompts: 3,
						snoozeMinutes: 15,
					},
				},
			);
			if (saved.kind !== "ready") return setStatus(failureText(saved));
		}
		const added = await apiRequest(
			Reminder,
			familyPath(familyId, "/reminders"),
			{
				method: "POST",
				body: {
					kind,
					subjectId: null,
					title: title.trim(),
					times: [
						...new Set(times.map((t) => t.value).filter((t) => t !== "")),
					].toSorted(),
				},
			},
		);
		if (added.kind !== "ready") return setStatus(failureText(added));
		setTitle("");
		setTimes([newTime()]);
		setStatus(`Saved: ${added.value.title}.`);
		setRefresh((n) => n + 1);
	};

	const remove = async (reminder: Reminder) => {
		setStatus("Deleting…");
		const deleted = await apiRequest(
			null,
			familyPath(familyId, `/reminders/${encodeURIComponent(reminder.id)}`),
			{ method: "DELETE" },
		);
		setStatus(
			deleted.kind === "ready"
				? `Deleted: ${reminder.title}.`
				: failureText(deleted),
		);
		setRefresh((n) => n + 1);
	};

	return (
		<form
			aria-label="Meal and drink reminders"
			className="win95-inset grid gap-2 bg-card p-2"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<p>
				Telly texts each reminder to the person's phone. They can reply DONE.
			</p>
			<ReminderList onDelete={remove} reminders={reminders} />
			<div className="flex flex-wrap items-end gap-2">
				<label className="grid min-w-40 flex-1 gap-1">
					What
					<input
						className={field}
						maxLength={200}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Lunch, Drink water"
						required
						value={title}
					/>
				</label>
				<label className="grid gap-1">
					Kind
					<select
						className={field}
						onChange={(e) =>
							setKind(e.target.value === "hydration" ? "hydration" : "meal")
						}
						value={kind}
					>
						<option value="meal">Meal</option>
						<option value="hydration">Drink</option>
					</select>
				</label>
				<TimeFields onChange={setTimes} times={times} />
				<Button
					className="win95-primary h-11"
					disabled={settings.kind !== "ready" || status === "Saving…"}
					type="submit"
				>
					Save reminder
				</Button>
			</div>
			{noSettings && (
				<p className="text-muted-foreground">
					Uses this browser's time zone, {zone}.
				</p>
			)}
			{settings.kind !== "ready" && settings.kind !== "loading" && (
				<ApiNotice state={settings} what="reminder settings" />
			)}
			{status !== null && <p role="status">{status}</p>}
		</form>
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
			<MealReminders familyId={familyId} />
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
