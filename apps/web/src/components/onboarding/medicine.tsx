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
import { type ReactNode, useRef, useState } from "react";

import {
	type CameraControl,
	CameraPreview,
	useCamera,
} from "@/components/hud/camera-preview";
import {
	bestMedicine,
	type PictureCheck,
	usePictureCheck,
} from "@/components/wearer/medicine-check";
import { CheckedPicture } from "@/components/wearer/medicine-picture";
import { apiRequest, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";
import { signInConfig } from "@/lib/sign-in";

import { failureText, type ReminderRules, reminderRules } from "./logic";
import { SaveForm, Source, TimeZoneSelect } from "./screens";

const field = "win95-inset win95-field h-11 w-full bg-card px-2";

const today = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Draft = { name: string; directions: string; time: string };
type Rules = { zone: string; repeat: string; max: string; snooze: string };
type LabelRead = {
	readonly label: string | null;
	readonly needsVerification: boolean;
};

/** Adds the medication instruction and returns its id, or the failure text. */
async function addInstruction(
	familyId: string,
	{ name, directions, time }: Draft,
): Promise<{ id: string } | { failure: string }> {
	const path = familyPath(familyId, "/care-instructions");
	const added = await apiRequest(null, path, {
		method: "POST",
		body: {
			kind: "medication",
			name,
			instruction: directions,
			times: [time],
			reason: null,
			source: "medicine box label",
			effectiveDate: today(),
		},
	});
	if (added.kind !== "ready") return { failure: failureText(added) };
	const list = await apiRequest(CareInstructions, path);
	if (list.kind !== "ready") return { failure: failureText(list) };
	// Newest first: the version just added.
	const mine = list.value.instructions.find(
		(i) =>
			i.kind === "medication" && i.name.toLowerCase() === name.toLowerCase(),
	);
	return mine === undefined
		? { failure: "The saved medicine is not visible yet." }
		: { id: mine.id };
}

/** Saves the reminder rules when given, then the instruction (once), then its reminder. */
async function saveMedicine(
	familyId: string,
	draft: Draft,
	rules: ReminderRules | null,
	instructionId: string | null,
	onInstruction: (id: string) => void,
): Promise<string | null> {
	if (rules !== null) {
		const saved = await apiRequest(
			null,
			familyPath(familyId, "/reminder-settings"),
			{ method: "PUT", body: rules },
		);
		if (saved.kind !== "ready") return failureText(saved);
	}
	let subjectId = instructionId;
	if (subjectId === null) {
		const added = await addInstruction(familyId, draft);
		if ("failure" in added) return added.failure;
		subjectId = added.id;
		onInstruction(added.id);
	}
	const reminder = await apiRequest(
		Reminder,
		familyPath(familyId, "/reminders"),
		{
			method: "POST",
			body: {
				kind: "medication",
				subjectId,
				title: draft.name,
				times: [draft.time],
			},
		},
	);
	return reminder.kind === "ready" ? null : failureText(reminder);
}

/** The one-line reason a picture check failed, or null while it looks or is done. */
function checkFailure(result: PictureCheck["result"] | undefined) {
	if (
		result === undefined ||
		result.kind === "done" ||
		result.kind === "looking"
	)
		return null;
	if (result.kind !== "signed_out") return result.message;
	return signInConfig() === null
		? "Sign-in is not set up on this server."
		: "Sign in to check pictures.";
}

/**
 * A new finished picture check seeds the name from the label, or empties it when none was read.
 * Later typing is the person's own until the next check.
 */
function useLabelRead(
	check: PictureCheck | null,
	setName: (name: string) => void,
) {
	const [read, setRead] = useState<LabelRead | null>(null);
	const [seededFor, setSeededFor] = useState<string | null>(null);
	if (check?.result.kind === "done" && check.id !== seededFor) {
		setSeededFor(check.id);
		const best = bestMedicine(check.result.detections);
		const label = best?.label?.trim() || null;
		setRead({ label, needsVerification: best?.needsVerification ?? true });
		setName(label ?? "");
	}
	return read;
}

function Field({
	id,
	label,
	value,
	onChange,
	type,
	inputMode,
	className = "grid gap-1",
	children,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: "time";
	inputMode?: "numeric";
	className?: string;
	children?: ReactNode;
}) {
	return (
		<div className={className}>
			<label htmlFor={id} className="font-bold">
				{label}
			</label>
			<input
				id={id}
				type={type}
				className={field}
				inputMode={inputMode}
				required
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			{children}
		</div>
	);
}

function PhotoPanel({
	camera,
	check,
	look,
	stop,
}: {
	camera: CameraControl;
	check: PictureCheck | null;
	look: (video: HTMLVideoElement | null) => Promise<unknown>;
	stop: () => void;
}) {
	const video = useRef<HTMLVideoElement | null>(null);
	const failed = checkFailure(check?.result);
	return (
		<>
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
								? bestMedicine(check.result.detections)
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
		</>
	);
}

function NameField({
	name,
	setName,
	read,
}: {
	name: string;
	setName: (name: string) => void;
	read: LabelRead | null;
}) {
	const seeded = read !== null && read.label !== null && name === read.label;
	return (
		<Field
			id="medicine-name"
			label="Name on the label"
			value={name}
			onChange={setName}
			className={`grid gap-1 ${seeded ? "border-[#006400] border-l-4 pl-1.5" : ""}`}
		>
			{seeded && <Source>Gemini photo check</Source>}
			{seeded && read?.needsVerification && (
				<b className="justify-self-start border border-black bg-[#ffffe1] px-1.5 text-xs">
					Check this name
				</b>
			)}
			{read !== null && read.label === null && (
				<p role="status">I could not read the label.</p>
			)}
		</Field>
	);
}

function RulesFields({
	rules,
	setRules,
	zone,
	profileZone,
}: {
	rules: Rules;
	setRules: (rules: Rules) => void;
	zone: string;
	profileZone: string | null;
}) {
	const rule = (key: "repeat" | "max" | "snooze", label: string) => (
		<Field
			id={`rule-${key}`}
			label={label}
			inputMode="numeric"
			value={rules[key]}
			onChange={(value) => setRules({ ...rules, [key]: value })}
		/>
	);
	return (
		<fieldset className="grid gap-2 border border-border p-2">
			<legend className="px-1 font-bold">How Telly reminds</legend>
			<p className="text-xs">
				This family has no reminder rules yet. These are suggestions; change
				them if needed.
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
	);
}

/** The family's reminder rules: whether onboarding must ask for them, and the typed ones to save. */
function useReminderRules(familyId: string) {
	const settings = useApi(
		SavedReminderSettings,
		familyPath(familyId, "/reminder-settings"),
	);
	const profile = useApi(
		CareProfileRecord,
		familyPath(familyId, "/care-profile"),
	);
	// Reminder cadence is an app setting, not data about the person: start from a visible suggestion.
	const [rules, setRules] = useState<Rules>({
		zone: "",
		repeat: "10",
		max: "3",
		snooze: "15",
	});
	const needRules =
		settings.kind === "ready" && settings.value.settings === null;
	const profileZone =
		profile.kind === "ready" ? profile.value.profile.timeZone : null;
	const zone = rules.zone !== "" ? rules.zone : (profileZone ?? "");
	const toSave = needRules ? reminderRules(zone, rules) : null;
	return {
		settings,
		needRules,
		toSave,
		ready: settings.kind === "ready" && (!needRules || toSave !== null),
		fields: { rules, setRules, zone, profileZone },
	};
}

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
	const picture = usePictureCheck(familyId, families);
	const reminder = useReminderRules(familyId);
	const [name, setName] = useState("");
	const [directions, setDirections] = useState("");
	const [time, setTime] = useState("");
	const [instructionId, setInstructionId] = useState<string | null>(null);
	const read = useLabelRead(picture.check, setName);
	const draft = { name: name.trim(), directions: directions.trim(), time };

	const save = async () => {
		const refused = await saveMedicine(
			familyId,
			draft,
			reminder.toSave,
			instructionId,
			setInstructionId,
		);
		if (refused === null) {
			onSaved(
				`Saved ${draft.name} with a reminder at ${time}. It is not verified yet: verify it in Care plan.`,
			);
			camera.stop();
		}
		return refused;
	};

	return (
		<SaveForm
			aria-label="First medicine"
			className="grid gap-3"
			label="Save medicine and reminder"
			ready={
				draft.name !== "" &&
				draft.directions !== "" &&
				time !== "" &&
				reminder.ready
			}
			save={save}
		>
			<PhotoPanel camera={camera} {...picture} />

			<NameField name={name} setName={setName} read={read} />
			<Field
				id="medicine-directions"
				label="Dose and directions, as on the label"
				value={directions}
				onChange={setDirections}
			/>
			<Field
				id="medicine-time"
				label="Remind at"
				type="time"
				value={time}
				onChange={setTime}
			/>

			{reminder.needRules && <RulesFields {...reminder.fields} />}
			{reminder.settings.kind !== "ready" &&
				reminder.settings.kind !== "loading" && (
					<p role="alert">
						Could not read the reminder rules: {failureText(reminder.settings)}
					</p>
				)}
		</SaveForm>
	);
}
