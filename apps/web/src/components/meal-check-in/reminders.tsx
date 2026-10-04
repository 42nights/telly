// Family › Reminders (#32, #340): the family's meal and drink reminders, which Telly texts to the
// person's phone. A compact list with Edit and Delete, a dialog to add or edit one, and a check
// next to each of today's times the person answered DONE.
import {
	Reminder,
	ReminderHistory,
	type ReminderKind,
	Reminders,
	SavedReminderSettings,
} from "@health/contracts/reminders";
import { Button } from "@health/ui/components/button";
import { Bell, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { Fragment, useId, useState } from "react";

import { failureText } from "@/components/chat/logic";
import { ApiNotice } from "@/components/win95";
import {
	type ApiState,
	apiRequest,
	familyPath,
	reread,
	useApi,
} from "@/lib/api";

type MealKind = Extract<ReminderKind, "meal" | "hydration">;
const isMealKind = (kind: ReminderKind): kind is MealKind =>
	kind === "meal" || kind === "hydration";

const field = "win95-inset win95-field h-11 min-w-0 bg-card px-2 text-sm";
const MAX_TIMES = 12;

type Draft = { title: string; kind: MealKind; times: readonly string[] };

/** Today's reminder times (`HH:MM` in `timeZone`) the person answered DONE, by reminder id. */
function doneToday(history: ApiState<ReminderHistory>, timeZone: string) {
	const done = new Map<string, Set<string>>();
	if (history.kind !== "ready") return done;
	const today = new Date().toLocaleDateString("en-CA", { timeZone });
	for (const { occurrence: o, events } of history.value.occurrences) {
		if (
			new Date(o.scheduledFor).toLocaleDateString("en-CA", { timeZone }) !==
			today
		)
			continue;
		if (
			!events.some(
				(e) =>
					e.state === "self_reported_complete" ||
					e.state === "caregiver_confirmed",
			)
		)
			continue;
		const time = new Date(o.scheduledFor).toLocaleTimeString("en-GB", {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		done.set(o.reminderId, (done.get(o.reminderId) ?? new Set()).add(time));
	}
	return done;
}

/** The add or edit dialog: What, Kind, and Times, each under its label. */
function ReminderDialog({
	reminder,
	onSave,
	onClose,
}: {
	reminder: Reminder | null;
	onSave: (draft: Draft) => Promise<string | null>;
	onClose: () => void;
}) {
	const id = useId();
	const [title, setTitle] = useState(reminder?.title ?? "");
	const [kind, setKind] = useState<MealKind>(
		reminder !== null && reminder.kind === "hydration" ? "hydration" : "meal",
	);
	// Keys stay stable while a time is edited; `crypto.randomUUID` names each new row.
	const [times, setTimes] = useState(() =>
		(reminder?.times ?? [""]).map((value) => ({
			key: crypto.randomUUID(),
			value,
		})),
	);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const heading = reminder === null ? "Add reminder" : "Edit reminder";

	return (
		<dialog
			ref={(d) => {
				if (d !== null && !d.open) d.showModal();
			}}
			onClose={onClose}
			aria-labelledby={`${id}-title`}
			className="win95-raised win95-window m-auto w-[min(22rem,calc(100vw-2rem))] border-0 p-1.5 text-foreground backdrop:bg-black/30"
		>
			<h2
				id={`${id}-title`}
				className="win95-titlebar flex items-center gap-1.5 px-1.5 py-1 text-sm"
			>
				<Bell aria-hidden className="size-4" /> {heading}
			</h2>
			<form
				aria-label={heading}
				className="grid gap-3 p-3 text-sm"
				onSubmit={(event) => {
					event.preventDefault();
					setSaving(true);
					void onSave({
						title: title.trim(),
						kind,
						times: times.map((t) => t.value),
					}).then((failure) => {
						setSaving(false);
						if (failure === null) onClose();
						else setError(failure);
					});
				}}
			>
				<label className="grid gap-1">
					What
					<input
						className={`${field} w-full`}
						maxLength={200}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Lunch"
						required
						value={title}
					/>
				</label>
				<label className="grid gap-1">
					Kind
					<select
						className={`${field} w-full`}
						onChange={(e) =>
							setKind(e.target.value === "hydration" ? "hydration" : "meal")
						}
						value={kind}
					>
						<option value="meal">Meal</option>
						<option value="hydration">Drink</option>
					</select>
				</label>
				<fieldset className="grid gap-1">
					<legend className="mb-1">Times</legend>
					<div className="flex flex-wrap gap-1">
						{times.map((time, index) => (
							<input
								aria-label={`Time ${index + 1}`}
								className={`${field} w-32`}
								key={time.key}
								onChange={(e) =>
									setTimes(
										times.map((t) =>
											t.key === time.key ? { ...t, value: e.target.value } : t,
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
								aria-label="Add a time"
								className="size-11"
								onClick={() =>
									setTimes([...times, { key: crypto.randomUUID(), value: "" }])
								}
								size="icon"
								title="Add a time"
								type="button"
							>
								<Plus aria-hidden />
							</Button>
						)}
					</div>
				</fieldset>
				{error !== null && (
					<p className="break-words text-destructive" role="alert">
						{error}
					</p>
				)}
				<div className="grid grid-cols-2 gap-2">
					<Button
						className="win95-primary h-11"
						disabled={saving}
						type="submit"
					>
						Save
					</Button>
					<Button className="h-11" onClick={onClose} type="button">
						Cancel
					</Button>
				</div>
			</form>
		</dialog>
	);
}

export function MealReminders({ familyId }: { familyId: string }) {
	const remindersPath = familyPath(familyId, "/reminders");
	const settingsPath = familyPath(familyId, "/reminder-settings");
	const reminders = useApi(Reminders, remindersPath);
	const settings = useApi(SavedReminderSettings, settingsPath);
	const history = useApi(
		ReminderHistory,
		familyPath(familyId, "/reminder-occurrences"),
		{ pollMs: 15_000 },
	);
	const [editing, setEditing] = useState<Reminder | "new" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const saved = settings.kind === "ready" ? settings.value.settings : null;
	// The family's saved time zone; before the first reminder, this browser's, saved with it.
	const zone =
		saved?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const done = doneToday(history, zone);

	const refresh = () => {
		void reread(remindersPath);
		void reread(settingsPath);
	};

	const deleteReminder = (reminder: Reminder) =>
		apiRequest(
			null,
			familyPath(familyId, `/reminders/${encodeURIComponent(reminder.id)}`),
			{ method: "DELETE" },
		);

	/** Saves the draft; an edit adds the new reminder, then deletes the old one. */
	const save = async (draft: Draft, replacing: Reminder | null) => {
		if (saved === null) {
			// The first reminder saves this browser's time zone as the family's.
			const put = await apiRequest(null, settingsPath, {
				method: "PUT",
				body: {
					timeZone: zone,
					quietHours: null,
					repeatEveryMinutes: 10,
					maxPrompts: 3,
					snoozeMinutes: 15,
				},
			});
			if (put.kind !== "ready") return failureText(put);
		}
		const added = await apiRequest(Reminder, remindersPath, {
			method: "POST",
			body: {
				kind: draft.kind,
				subjectId: null,
				title: draft.title,
				times: [...new Set(draft.times.filter((t) => t !== ""))].toSorted(),
			},
		});
		if (added.kind !== "ready") return failureText(added);
		const removed = replacing === null ? null : await deleteReminder(replacing);
		refresh();
		return removed === null || removed.kind === "ready"
			? null
			: failureText(removed);
	};

	const remove = async (reminder: Reminder) => {
		const deleted = await deleteReminder(reminder);
		setError(deleted.kind === "ready" ? null : failureText(deleted));
		refresh();
	};

	const meals =
		reminders.kind === "ready"
			? reminders.value.reminders.filter((r) => isMealKind(r.kind))
			: [];

	return (
		<div className="grid content-start gap-2">
			{reminders.kind !== "ready" ? (
				<ApiNotice state={reminders} what="reminders" />
			) : (
				meals.length > 0 && (
					<ul className="win95-inset grid bg-card" aria-label="Reminders">
						{meals.map((reminder) => (
							<li
								className="flex items-center gap-1 border-border border-b p-1 last:border-b-0"
								key={reminder.id}
							>
								<span className="min-w-0 flex-1 break-words px-1">
									<b>{reminder.title}</b>
									{" · "}
									{reminder.times.map((time, index) => (
										<Fragment key={time}>
											{index > 0 && ", "}
											{time}
											{done.get(reminder.id)?.has(time) && (
												<Check
													aria-label={`Done at ${time}`}
													className="ml-0.5 inline size-3.5 align-[-2px] text-green-700"
													role="img"
												/>
											)}
										</Fragment>
									))}
								</span>
								<Button
									aria-label={`Edit ${reminder.title}`}
									className="size-11"
									onClick={() => setEditing(reminder)}
									size="icon"
									title="Edit"
									type="button"
								>
									<Pencil aria-hidden />
								</Button>
								<Button
									aria-label={`Delete ${reminder.title}`}
									className="size-11"
									onClick={() => void remove(reminder)}
									size="icon"
									title="Delete"
									type="button"
								>
									<Trash2 aria-hidden />
								</Button>
							</li>
						))}
					</ul>
				)
			)}
			{error !== null && (
				<p className="break-words text-destructive" role="alert">
					{error}
				</p>
			)}
			{settings.kind !== "ready" && settings.kind !== "loading" && (
				<ApiNotice state={settings} what="reminder settings" />
			)}
			<Button
				className="h-11 justify-self-start"
				disabled={settings.kind !== "ready"}
				onClick={() => setEditing("new")}
				type="button"
			>
				<Plus aria-hidden /> Add reminder
			</Button>
			{editing !== null && (
				<ReminderDialog
					key={editing === "new" ? "new" : editing.id}
					onClose={() => setEditing(null)}
					onSave={(draft) => save(draft, editing === "new" ? null : editing)}
					reminder={editing === "new" ? null : editing}
				/>
			)}
		</div>
	);
}
