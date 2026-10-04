import type { CareProfileRecord } from "@health/contracts/care-profile";
import { Button } from "@health/ui/components/button";
import { ClipboardList } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { memberLabel } from "@/lib/members";

import type { CareData } from "./data";
import { fromForm, type ProfileForm, toForm } from "./logic";

const fields: ReadonlyArray<{
	key: keyof ProfileForm;
	label: string;
	hint?: string;
	multiline?: boolean;
}> = [
	{ key: "preferredName", label: "Preferred name" },
	{ key: "language", label: "Language" },
	{ key: "timeZone", label: "Time zone", hint: "For example Europe/London." },
	{ key: "accessibilityNeeds", label: "Accessibility needs", multiline: true },
	{ key: "diagnoses", label: "Conditions (diagnoses)", multiline: true },
	{ key: "allergies", label: "Allergies", multiline: true },
	{ key: "dietaryRestrictions", label: "Food restrictions", multiline: true },
	{ key: "fluidRestrictions", label: "Drink restrictions", multiline: true },
	{
		key: "activityRestrictions",
		label: "Activity restrictions",
		multiline: true,
	},
	{
		key: "routines",
		label: "Routines",
		hint: "One per line: name; HH:MM (time optional).",
		multiline: true,
	},
	{
		key: "contacts",
		label: "Contacts, in call order",
		hint: "One per line: name; relationship; phone.",
		multiline: true,
	},
	{
		key: "familiarDestinations",
		label: "Familiar places",
		hint: "One per line: name; address.",
		multiline: true,
	},
	{ key: "devices", label: "Available devices", multiline: true },
	{
		key: "declinedPrompts",
		label: "Reminders the wearer declined",
		hint: "One kind per line, for example meals. Leave empty when none.",
		multiline: true,
	},
];

const savedText = (record: CareProfileRecord, me: string | null) =>
	record.editedBy === null || record.editedAt === null
		? "Not saved yet: every fact is unknown."
		: `Saved by ${memberLabel(record.editedBy, me)} on ${new Date(record.editedAt).toLocaleString()} · ${record.history.length} version(s)`;

/** The care profile: every fact the wearer's prompts use, with who saved it and when. */
export function ProfileWindow({
	record,
	canEdit,
	care,
}: {
	record: CareProfileRecord;
	canEdit: boolean;
	care: CareData;
}) {
	const [form, setForm] = useState(() => toForm(record.profile));
	const [message, setMessage] = useState<string | null>(null);
	const profile = fromForm(form);
	return (
		<Window
			title="Care profile"
			icon={ClipboardList}
			status={message ?? savedText(record, care.me)}
		>
			<form
				aria-label="Care profile"
				className="grid gap-2 p-2 text-sm"
				onSubmit={async (event) => {
					event.preventDefault();
					if (profile === null) return;
					setMessage("Saving…");
					const refused = await care.write("PUT", "/care-profile", profile);
					setMessage(refused ?? "Saved.");
				}}
			>
				<p>
					Leave a box empty when the fact is unknown. Write <b>none</b> when
					there are none.
				</p>
				{fields.map(({ key, label, hint, multiline }) => {
					const id = `care-${key}`;
					const props = {
						id,
						value: form[key],
						readOnly: !canEdit,
						"aria-describedby": hint === undefined ? undefined : `${id}-hint`,
						className: "win95-inset win95-field w-full bg-card px-2 py-1",
						onChange: (
							event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
						) => setForm({ ...form, [key]: event.target.value }),
					};
					return (
						<div key={key} className="grid gap-1">
							<label htmlFor={id} className="font-bold">
								{label}
							</label>
							{multiline ? (
								<textarea rows={2} {...props} />
							) : (
								<input {...props} className={`${props.className} h-11`} />
							)}
							{hint !== undefined && <small id={`${id}-hint`}>{hint}</small>}
						</div>
					);
				})}
				{profile === null && (
					<p role="alert">A box does not match its format.</p>
				)}
				{canEdit ? (
					<Button
						type="submit"
						className="win95-primary h-11 justify-self-end px-6 text-sm"
						disabled={profile === null}
					>
						Save profile
					</Button>
				) : (
					<p>Your access does not include editing the care plan.</p>
				)}
			</form>
		</Window>
	);
}
