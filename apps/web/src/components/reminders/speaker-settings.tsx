// Home-speaker settings (issue #46). The wearer turns the channel on and chooses what a speaker in a
// shared room may say. The only speaker is a simulator: it plays no sound, and this window shows what
// it would have said.
import type { ReminderKind } from "@health/contracts/reminders";
import {
	SavedSpeakerSettings,
	type SimulatedSpeakerMode,
	type SpeakerSettings,
	SpeakerStatus,
} from "@health/contracts/speaker";
import { Button } from "@health/ui/components/button";
import { Speaker } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { ApiNotice, Tip } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

const KIND_TEXT: Record<ReminderKind, string> = {
	medication: "Medicine",
	meal: "Meals",
	hydration: "Drinks",
	appointment: "Appointments",
	charging: "Charging",
	routine: "Routines",
};
const KINDS = Object.keys(KIND_TEXT) as ReminderKind[];

const MODE_TEXT: Record<SimulatedSpeakerMode, string> = {
	online: "Online",
	offline: "Offline",
	refused: "Refuses the reminder",
};

export function SpeakerSettingsWindow() {
	const { family } = useFamily();
	const path = family === null ? null : familyPath(family.id);
	const saved = useApi(
		SavedSpeakerSettings,
		path === null ? null : `${path}/speaker-settings`,
	);
	return (
		<Window
			title="Settings · Home speaker (simulated)"
			icon={Speaker}
			status="No real speaker: the simulator plays no sound."
		>
			{path === null ? (
				<p className="p-3 text-sm">No person is paired yet.</p>
			) : saved.kind !== "ready" ? (
				<ApiNotice state={saved} what="the speaker settings" />
			) : (
				<div className="grid gap-3 p-2 text-sm">
					<SpeakerForm
						key={saved.value.updatedAt ?? "default"}
						path={path}
						saved={saved.value.settings}
						savedAt={saved.value.updatedAt}
					/>
					<SimulatorGroup path={path} />
				</div>
			)}
		</Window>
	);
}

function SpeakerForm({
	path,
	saved,
	savedAt,
}: {
	path: string;
	saved: SpeakerSettings;
	savedAt: string | null;
}) {
	const [draft, setDraft] = useState(saved);
	const [status, setStatus] = useState<string | null>(null);
	const set = (patch: Partial<SpeakerSettings>) =>
		setDraft({ ...draft, ...patch });
	const save = async () => {
		setStatus("Saving…");
		const result = await apiRequest(
			SavedSpeakerSettings,
			`${path}/speaker-settings`,
			{ method: "PUT", body: draft },
		);
		if (result.kind !== "ready")
			setStatus(
				result.kind === "signed_out"
					? "Sign in to save."
					: `Not saved: ${result.message}`,
			);
	};
	return (
		<form
			aria-label="Home speaker"
			className="grid gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<label className="flex min-h-11 items-center gap-2">
				<input
					type="checkbox"
					checked={draft.enabled}
					onChange={(e) => set({ enabled: e.target.checked })}
				/>
				Say due reminders on the home speaker while my glasses charge
			</label>
			<div className="grid gap-1">
				<span className="flex items-center gap-1">
					<label htmlFor="speaker-room">Where is the speaker?</label>
					<Tip
						text={
							draft.room === "shared"
								? "Other people can hear a speaker in a shared room. It says only “You have a reminder. Please check your phone.” It says the name only for the kinds below."
								: "It says the reminder name, such as the medicine."
						}
					/>
				</span>
				<select
					id="speaker-room"
					className="win95-inset win95-field h-11 bg-card px-2 text-sm"
					value={draft.room}
					onChange={(e) =>
						set({ room: e.target.value as SpeakerSettings["room"] })
					}
				>
					<option value="shared">A shared room</option>
					<option value="private">A private room</option>
				</select>
			</div>
			<fieldset
				className="grid gap-1 border border-border p-2"
				disabled={draft.room === "private"}
			>
				<legend className="px-1">In a shared room, also say the name of</legend>
				<div className="flex flex-wrap gap-x-4">
					{KINDS.map((kind) => (
						<label key={kind} className="flex min-h-11 items-center gap-1.5">
							<input
								type="checkbox"
								checked={draft.sharedRoomKinds.includes(kind)}
								onChange={(e) =>
									set({
										sharedRoomKinds: e.target.checked
											? [...draft.sharedRoomKinds, kind]
											: draft.sharedRoomKinds.filter((k) => k !== kind),
									})
								}
							/>
							{KIND_TEXT[kind]}
						</label>
					))}
				</div>
			</fieldset>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p role="status">
					{status ??
						(savedAt === null
							? "Not saved yet: the speaker is off."
							: `Saved · ${new Date(savedAt).toLocaleTimeString([], { timeStyle: "short" })}`)}
				</p>
				<Button type="submit" className="win95-primary h-11 px-6 text-sm">
					Save
				</Button>
			</div>
		</form>
	);
}

/** The simulator's state and what it said, newest first. */
function SimulatorGroup({ path }: { path: string }) {
	const speaker = useApi(SpeakerStatus, `${path}/speaker`, {
		pollMs: 15_000,
	});
	const [error, setError] = useState<string | null>(null);
	const setMode = async (mode: SimulatedSpeakerMode) => {
		const result = await apiRequest(
			SpeakerStatus,
			`${path}/speaker/simulator`,
			{
				method: "PUT",
				body: { mode },
			},
		);
		setError(
			result.kind === "ready" || result.kind === "signed_out"
				? null
				: result.message,
		);
	};
	return (
		<fieldset className="grid gap-2 border border-border p-2">
			<legend className="px-1">Simulated speaker</legend>
			{speaker.kind !== "ready" ? (
				<ApiNotice state={speaker} what="the simulated speaker" />
			) : (
				<>
					<label className="flex items-center gap-2">
						Speaker state
						<select
							className="win95-inset win95-field h-11 min-w-0 flex-1 bg-card px-2 text-sm"
							value={speaker.value.mode}
							onChange={(e) =>
								void setMode(e.target.value as SimulatedSpeakerMode)
							}
						>
							{(Object.keys(MODE_TEXT) as SimulatedSpeakerMode[]).map((m) => (
								<option key={m} value={m}>
									{MODE_TEXT[m]}
								</option>
							))}
						</select>
					</label>
					{error !== null && (
						<p role="alert" className="font-bold text-destructive">
							Not changed: {error}
						</p>
					)}
					{speaker.value.announcements.length === 0 ? (
						<p>
							<b>What it said:</b> nothing yet.
						</p>
					) : (
						<>
							<h3 className="font-bold">What it said</h3>
							<ol className="win95-inset grid max-h-40 gap-1 overflow-y-auto bg-card p-2">
								{speaker.value.announcements.map((a) => (
									<li key={`${a.occurrenceId}-${a.at}`}>
										<time dateTime={a.at}>
											{new Date(a.at).toLocaleTimeString([], {
												timeStyle: "short",
											})}
										</time>
										{" · "}“{a.text}”
									</li>
								))}
							</ol>
						</>
					)}
				</>
			)}
		</fieldset>
	);
}
