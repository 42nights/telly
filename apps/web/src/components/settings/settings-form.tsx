import type { Family } from "@health/contracts";
import type { FamilyList } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { Settings } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { SUPPORT_MAILTO, Tip } from "@/components/win95";
import type { ApiState } from "@/lib/api";
import { type Contacts, isFullPhoneNumber, useContacts } from "@/lib/contacts";
import { useFamily } from "@/lib/family";

const INVALID = "Enter a full phone number, like (555) 010-0123";

/** Settings, variation A: a form dialog for the person and the call-button numbers. */
export function SettingsForm() {
	const [contacts, save] = useContacts();
	// Remount when the saved numbers change, so the boxes start from what this device stored.
	return (
		<NumbersForm
			key={`${contacts.savedAt}:${contacts.momPhone}:${contacts.familyPhone}:${contacts.emergency}`}
			contacts={contacts}
			save={save}
		/>
	);
}

/** The status bar text: invalid input, unsaved changes, then the last save on this device. */
const numbersStatus = (
	valid: boolean,
	changed: boolean,
	savedAt: number | null,
): string => {
	if (!valid) return "Not saved";
	if (changed) return "Changes not saved";
	if (savedAt === null) return "Nothing to save yet";
	return `Saved on this device · ${new Date(savedAt).toLocaleTimeString(undefined, { timeStyle: "short" })}`;
};

/** The selected person's name, or why there is none. */
const personText = (
	state: ApiState<FamilyList>,
	family: Family | null,
): string => {
	if (family !== null) return family.name;
	if (state.kind === "loading") return "Loading…";
	if (state.kind === "signed_out") return "Sign in to see the person";
	if (state.kind === "ready") return "No person yet";
	return `Not available: ${state.message}`;
};

function PersonGroup() {
	const { state, family } = useFamily();
	return (
		<fieldset className="border border-border px-2 pb-1">
			<legend className="px-1">Person</legend>
			<b className="block truncate">{personText(state, family)}</b>
		</fieldset>
	);
}

/** One number box. Blank is valid only with `blankNote`, which then says what stays off. */
function useNumber(saved: string | null, blankNote?: string) {
	const [value, setValue] = useState(saved ?? "");
	const trimmed = value.trim();
	const blank = trimmed === "";
	const valid = (blank && blankNote !== undefined) || isFullPhoneNumber(value);
	return {
		valid,
		changed: trimmed !== (saved ?? ""),
		next: blank ? null : trimmed,
		field: {
			value,
			onChange: setValue,
			error: valid ? null : INVALID,
			note: blank ? (blankNote ?? null) : null,
		},
	};
}

function NumbersForm({
	contacts,
	save,
}: {
	contacts: Contacts;
	save: (next: Contacts) => void;
}) {
	const mom = useNumber(contacts.momPhone, "Call Mom is off until you add one");
	const family = useNumber(
		contacts.familyPhone,
		"Call family is off until you add one",
	);
	const emergency = useNumber(contacts.emergency);
	const changed = mom.changed || family.changed || emergency.changed;
	const valid = mom.valid && family.valid && emergency.valid;

	const status = numbersStatus(valid, changed, contacts.savedAt);

	return (
		<Window title="Settings · Phone numbers" icon={Settings} status={status}>
			<form
				aria-label="Phone numbers"
				className="grid gap-3 p-2 text-sm"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed && valid)
						save({
							momPhone: mom.next,
							familyPhone: family.next,
							emergency: emergency.next ?? contacts.emergency,
							savedAt: contacts.savedAt,
						});
				}}
			>
				<PersonGroup />

				<fieldset className="grid gap-2 border border-border p-2">
					<legend className="flex items-center gap-1 px-1">
						Numbers for the call buttons
						<Tip text="Calls start from your phone's dialer. The app never calls or texts by itself." />
					</legend>
					<NumberField
						id="settings-mom"
						label="Mom's phone number"
						{...mom.field}
					/>
					<NumberField
						id="settings-family"
						label="Family phone number"
						tip="The person's Home screen calls this number with Call family."
						{...family.field}
					/>
					<NumberField
						id="settings-emergency"
						label="Emergency number"
						tip="911 is the US number. Outside the US, enter your local emergency number, for example 112 or 999."
						{...emergency.field}
					/>
					<p className="flex items-center gap-1">
						Calls start from your phone's dialer.
						<Tip text="The call buttons never call by themselves." />
					</p>
				</fieldset>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<a href={SUPPORT_MAILTO} className="underline">
						Contact support
					</a>
					<Button
						type="submit"
						className="win95-primary h-11 px-6 text-sm"
						disabled={!changed || !valid}
					>
						Save
					</Button>
				</div>
			</form>
		</Window>
	);
}

function NumberField({
	id,
	label,
	tip,
	value,
	onChange,
	error,
	note,
}: {
	id: string;
	label: string;
	tip?: string;
	value: string;
	onChange: (value: string) => void;
	error: string | null;
	note: string | null;
}) {
	return (
		<div className="grid gap-1">
			<span className="flex items-center gap-1">
				<label htmlFor={id}>{label}</label>
				{tip !== undefined && <Tip text={tip} />}
			</span>
			<input
				id={id}
				type="tel"
				autoComplete="tel"
				className="win95-inset win95-field h-11 w-full bg-card px-2 text-base"
				value={value}
				// What stays off while the box is blank: a hint in the empty box, not another line.
				placeholder={note ?? undefined}
				aria-invalid={error !== null}
				aria-describedby={error !== null ? `${id}-error` : undefined}
				onChange={(event) => onChange(event.target.value)}
			/>
			{error !== null && (
				<p id={`${id}-error`} className="font-bold text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
