// Onboarding "First medicine" (.lavish/onboarding-plan.html#wf-4b): a photo of the real box, read by
// the existing medicine picture check. The label only seeds the name; the person confirms it, types
// the directions, and picks the time. Saving adds the medication instruction (#26) and its reminder
// (#28) through the same routes as the Care plan and reminders.
import {
	CareInstructions,
	CareProfileRecord,
} from "@health/contracts/care-profile";
import { Reminder, SavedReminderSettings } from "@health/contracts/reminders";
import { Button } from "@health/ui/components/button";
import { Camera } from "lucide-react";
import { useRef, useState } from "react";

import { CameraPreview, useCamera } from "@/components/hud/camera-preview";
import {
	bestDetection,
	usePictureCheck,
} from "@/components/wearer/medicine-check";
import { CheckedPicture } from "@/components/wearer/medicine-picture";
import { apiRequest, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";
import { signInConfig } from "@/lib/sign-in";

import { failureText } from "./logic";
import { Source, TimeZoneSelect } from "./screens";

const field = "win95-inset win95-field h-11 w-full bg-card px-2";

const today = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A required whole number from a text field, or null when empty or not a whole number. */
const wholeNumber = (text: string) =>
	/^\d+$/.test(text.trim()) ? Number(text.trim()) : null;

export function FirstMedicine({
	familyId,
	onSaved,
}: {
	familyId: string;
	onSaved: (message: string) => void;
}) {
	const { state: families } = useFamily();
	// The camera starts here, after "Take photo"; never on its own.
	const camera = useCamera(true);
	const { check, look, stop } = usePictureCheck(familyId, families);
	const video = useRef<HTMLVideoElement | null>(null);
	const settings = useApi(
		SavedReminderSettings,
		familyPath(familyId, "/reminder-settings"),
	);
	const profile = useApi(
		CareProfileRecord,
		familyPath(familyId, "/care-profile"),
	);

	const [name, setName] = useState("");
	const [read, setRead] = useState<{
		readonly label: string | null;
		readonly needsVerification: boolean;
	} | null>(null);
	const [directions, setDirections] = useState("");
	const [time, setTime] = useState("");
	const [rules, setRules] = useState({
		zone: "",
		repeat: "",
		max: "",
		snooze: "",
	});
	const [instructionId, setInstructionId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A new finished picture check seeds the name from the label, or empties it when none was read.
	// Later typing is the person's own until the next check.
	const [seededFor, setSeededFor] = useState<string | null>(null);
	if (check?.result.kind === "done" && check.id !== seededFor) {
		setSeededFor(check.id);
		const best = bestDetection(check.result.detections);
		const label = best?.label?.trim() || null;
		setRead({ label, needsVerification: best?.needsVerification ?? true });
		setName(label ?? "");
	}
	const needRules =
		settings.kind === "ready" && settings.value.settings === null;
	const profileZone =
		profile.kind === "ready" ? profile.value.profile.timeZone : null;
	const zone = rules.zone !== "" ? rules.zone : (profileZone ?? "");
	const repeat = wholeNumber(rules.repeat);
	const max = wholeNumber(rules.max);
	const snooze = wholeNumber(rules.snooze);
	const ready =
		name.trim() !== "" &&
		directions.trim() !== "" &&
		time !== "" &&
		settings.kind === "ready" &&
		(!needRules ||
			(zone !== "" && repeat !== null && max !== null && snooze !== null));

	const save = async (): Promise<string | null> => {
		const path = (sub: string) => familyPath(familyId, sub);
		if (needRules) {
			const saved = await apiRequest(null, path("/reminder-settings"), {
				method: "PUT",
				body: {
					timeZone: zone,
					quietHours: null,
					repeatEveryMinutes: repeat,
					maxPrompts: max,
					snoozeMinutes: snooze,
				},
			});
			if (saved.kind !== "ready") return failureText(saved);
		}
		let subjectId = instructionId;
		if (subjectId === null) {
			const added = await apiRequest(null, path("/care-instructions"), {
				method: "POST",
				body: {
					kind: "medication",
					name: name.trim(),
					instruction: directions.trim(),
					times: [time],
					reason: null,
					source: "medicine box label",
					effectiveDate: today(),
				},
			});
			if (added.kind !== "ready") return failureText(added);
			const list = await apiRequest(
				CareInstructions,
				path("/care-instructions"),
			);
			if (list.kind !== "ready") return failureText(list);
			// Newest first: the version just added.
			const mine = list.value.instructions.find(
				(i) =>
					i.kind === "medication" &&
					i.name.toLowerCase() === name.trim().toLowerCase(),
			);
			if (mine === undefined) return "The saved medicine is not visible yet.";
			subjectId = mine.id;
			setInstructionId(mine.id);
		}
		const reminder = await apiRequest(Reminder, path("/reminders"), {
			method: "POST",
			body: {
				kind: "medication",
				subjectId,
				title: name.trim(),
				times: [time],
			},
		});
		if (reminder.kind !== "ready") return failureText(reminder);
		onSaved(
			`Saved ${name.trim()} with a reminder at ${time}. It is not verified yet: verify it in Care plan.`,
		);
		return null;
	};

	const result = check?.result;
	const failed =
		result !== undefined &&
		result.kind !== "done" &&
		result.kind !== "looking" &&
		result.kind !== "cleared"
			? result.kind === "signed_out"
				? signInConfig() === null
					? "Sign-in is not set up on this server."
					: "Sign in to check pictures."
				: result.message
			: null;
	const seeded = read !== null && read.label !== null && name === read.label;

	const rule = (key: "repeat" | "max" | "snooze", label: string) => (
		<div className="grid gap-1">
			<label htmlFor={`rule-${key}`} className="font-bold">
				{label}
			</label>
			<input
				id={`rule-${key}`}
				className={field}
				inputMode="numeric"
				required
				value={rules[key]}
				onChange={(event) => setRules({ ...rules, [key]: event.target.value })}
			/>
		</div>
	);

	return (
		<form
			aria-label="First medicine"
			className="grid gap-3"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				const refused = await save();
				setBusy(false);
				setError(refused);
				if (refused === null) camera.stop();
			}}
		>
			<div className="win95-inset relative aspect-[4/3] min-w-0 overflow-hidden bg-card">
				<CameraPreview
					camera={camera}
					onVideo={(element) => {
						video.current = element;
					}}
				>
					<Button type="button" onClick={() => void look(video.current)}>
						<Camera aria-hidden />
						Read the label
					</Button>
				</CameraPreview>
				{check !== null && (
					<CheckedPicture
						best={
							check.result.kind === "done"
								? bestDetection(check.result.detections)
								: null
						}
						check={check}
					/>
				)}
			</div>
			{check !== null && (
				<Button type="button" className="h-11" onClick={stop}>
					Take another photo
				</Button>
			)}
			{failed !== null && <p role="alert">{failed}</p>}

			<div
				className={`grid gap-1 ${seeded ? "border-[#006400] border-l-4 pl-1.5" : ""}`}
			>
				<label htmlFor="medicine-name" className="font-bold">
					Name on the label
				</label>
				<input
					id="medicine-name"
					className={field}
					required
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				{seeded && <Source>Gemini photo check</Source>}
				{seeded && read?.needsVerification && (
					<b className="justify-self-start border border-black bg-[#ffffe1] px-1.5 text-xs">
						Check this name
					</b>
				)}
				{read !== null && read.label === null && (
					<p role="status">I could not read the label.</p>
				)}
			</div>
			<div className="grid gap-1">
				<label htmlFor="medicine-directions" className="font-bold">
					Dose and directions, as on the label
				</label>
				<input
					id="medicine-directions"
					className={field}
					required
					value={directions}
					onChange={(event) => setDirections(event.target.value)}
				/>
			</div>
			<div className="grid gap-1">
				<label htmlFor="medicine-time" className="font-bold">
					Remind at
				</label>
				<input
					id="medicine-time"
					type="time"
					className={field}
					required
					value={time}
					onChange={(event) => setTime(event.target.value)}
				/>
			</div>

			{needRules && (
				<fieldset className="grid gap-2 border border-border p-2">
					<legend className="px-1 font-bold">How Telly reminds</legend>
					<p className="text-xs">
						This family has no reminder rules yet. Choose them once.
					</p>
					<div className="grid gap-1">
						<label htmlFor="rule-zone" className="font-bold">
							Time zone
						</label>
						<TimeZoneSelect
							id="rule-zone"
							value={zone}
							onChange={(next) => setRules({ ...rules, zone: next })}
						/>
						{rules.zone === "" && profileZone !== null && (
							<Source>care plan</Source>
						)}
					</div>
					{rule("repeat", "Ask again every (minutes, 1–240)")}
					{rule("max", "Ask at most (times, 1–10)")}
					{rule("snooze", "“Later” waits (minutes, 1–240)")}
				</fieldset>
			)}
			{settings.kind !== "ready" && settings.kind !== "loading" && (
				<p role="alert">
					Could not read the reminder rules: {failureText(settings)}
				</p>
			)}
			{error !== null && <p role="alert">{error}</p>}
			<Button
				type="submit"
				className="win95-primary h-11 w-full"
				disabled={busy || !ready}
			>
				{busy ? "Saving…" : "Save medicine and reminder"}
			</Button>
		</form>
	);
}
