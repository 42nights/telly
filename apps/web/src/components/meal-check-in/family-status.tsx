// Meal and drink check-ins for the family (#32): the reminder times a family member sets (Family ›
// Reminders), and for each due check-in whether a device showed it, whether the wearer said they ate
// or drank, and whether it is unresolved, as three separate facts (Family › Daily).
import {
	Reminder,
	ReminderHistory,
	Reminders,
	SavedReminderSettings,
} from "@health/contracts/reminders";
import { Button } from "@health/ui/components/button";
import { Plus, Trash2, Utensils } from "lucide-react";
import { useRef, useState } from "react";

import { failureText } from "@/components/chat/logic";
import { ApiNotice, Tip } from "@/components/win95";
import {
	type ApiState,
	apiRequest,
	familyPath,
	reread,
	useApi,
} from "@/lib/api";

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

/** One `<input type="time">` per reminder time, and a "+" that adds one, up to `MAX_TIMES`. */
function TimeFields({
	times,
	onChange,
}: {
	times: readonly Time[];
	onChange: (times: readonly Time[]) => void;
}) {
	return (
		<div className="flex flex-wrap gap-1">
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
					aria-label="Add another time"
					className="h-11"
					onClick={() => onChange([...times, newTime()])}
					type="button"
				>
					<Plus aria-hidden />
				</Button>
			)}
		</div>
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
	if (meals.length === 0) return <p>No meal or drink reminder yet.</p>;
	return (
		<ul className="win95-inset grid gap-1 bg-card p-2">
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

/**
 * Family › Reminders: the family's meal and drink reminders as a short list with Delete, and Add,
 * which opens a small dialog with aligned fields.
 */
export function MealReminders({ familyId }: { familyId: string }) {
	const remindersPath = familyPath(familyId, "/reminders");
	const settingsPath = familyPath(familyId, "/reminder-settings");
	const reminders = useApi(Reminders, remindersPath);
	const settings = useApi(SavedReminderSettings, settingsPath);
	const dialog = useRef<HTMLDialogElement>(null);
	const refresh = () => {
		void reread(remindersPath);
		void reread(settingsPath);
	};
	const [title, setTitle] = useState("");
	const [kind, setKind] = useState<"meal" | "hydration">("meal");
	const [times, setTimes] = useState<readonly Time[]>(() => [newTime()]);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const noSettings =
		settings.kind === "ready" && settings.value.settings === null;
	const saving = status === "Saving…";

	const save = async () => {
		setError(null);
		setStatus("Saving…");
		if (noSettings) {
			const saved = await apiRequest(null, settingsPath, {
				method: "PUT",
				body: {
					timeZone: zone,
					quietHours: null,
					repeatEveryMinutes: 10,
					maxPrompts: 3,
					snoozeMinutes: 15,
				},
			});
			if (saved.kind !== "ready") {
				setStatus(null);
				return setError(failureText(saved));
			}
		}
		const added = await apiRequest(Reminder, remindersPath, {
			method: "POST",
			body: {
				kind,
				subjectId: null,
				title: title.trim(),
				times: [
					...new Set(times.map((t) => t.value).filter((t) => t !== "")),
				].toSorted(),
			},
		});
		if (added.kind !== "ready") {
			setStatus(null);
			return setError(failureText(added));
		}
		setTitle("");
		setTimes([newTime()]);
		setStatus(`Saved: ${added.value.title}.`);
		dialog.current?.close();
		refresh();
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
		refresh();
	};

	return (
		<section aria-labelledby="meal-reminders" className="grid gap-2">
			<div className="flex items-center gap-1">
				<h3 id="meal-reminders" className="font-bold">
					Meals and drinks
				</h3>
				<Tip text="Telly texts each reminder to the person's phone. They can reply DONE." />
				<Button
					className="ml-auto h-11"
					disabled={settings.kind !== "ready"}
					onClick={() => {
						setError(null);
						dialog.current?.showModal();
					}}
				>
					<Plus aria-hidden />
					Add
				</Button>
			</div>
			<ReminderList onDelete={remove} reminders={reminders} />
			{settings.kind !== "ready" && settings.kind !== "loading" && (
				<ApiNotice state={settings} what="reminder settings" />
			)}
			{status !== null && <p role="status">{status}</p>}
			<dialog
				ref={dialog}
				aria-labelledby="add-reminder"
				className="win95-raised win95-window m-auto w-[min(24rem,calc(100vw-1rem))] border-0 p-1.5 text-foreground backdrop:bg-black/30"
			>
				<h2
					id="add-reminder"
					className="win95-titlebar flex items-center gap-1.5 px-1.5 py-1 text-sm"
				>
					<Utensils aria-hidden className="size-4" /> Add a reminder
				</h2>
				<form
					aria-label="Add a meal or drink reminder"
					className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 p-2 text-sm"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label htmlFor="reminder-what">What</label>
					<input
						className={field}
						id="reminder-what"
						maxLength={200}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Lunch, Drink water"
						required
						value={title}
					/>
					<label htmlFor="reminder-kind">Kind</label>
					<select
						className={field}
						id="reminder-kind"
						onChange={(e) =>
							setKind(e.target.value === "hydration" ? "hydration" : "meal")
						}
						value={kind}
					>
						<option value="meal">Meal</option>
						<option value="hydration">Drink</option>
					</select>
					<span className="flex items-center gap-1 self-start pt-3">
						Times
						{noSettings && (
							<Tip text={`Uses this browser's time zone, ${zone}.`} />
						)}
					</span>
					<TimeFields onChange={setTimes} times={times} />
					{error !== null && (
						<p className="col-span-2 font-bold text-destructive" role="alert">
							Not saved: {error}
						</p>
					)}
					<div className="col-span-2 grid grid-cols-2 gap-2">
						<Button
							className="win95-primary h-11"
							disabled={saving}
							type="submit"
						>
							Save
						</Button>
						<Button
							className="h-11"
							onClick={() => dialog.current?.close()}
							type="button"
						>
							Cancel
						</Button>
					</div>
				</form>
			</dialog>
		</section>
	);
}

/** Family › Daily: the meal and drink check-ins that came due. Nothing shows while none has. */
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
	if (state.kind === "ready" && due.length === 0) return null;
	return (
		<section aria-labelledby="meals" className="grid gap-2">
			<div className="flex items-center gap-1">
				<h3 id="meals" className="font-bold">
					Meals and drinks
				</h3>
				<Tip text="“Says they did” is the person's own report. It does not show how much they ate or drank, or that they are well." />
			</div>
			<div className="win95-inset grid gap-3 bg-card p-2">
				{state.kind !== "ready" ? (
					<ApiNotice state={state} what="meal check-ins" />
				) : (
					<>
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
