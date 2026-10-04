// Save & Call (#360, #379): a call button with no number saved asks for the number in place. The
// number is saved on this device and added to the care profile contacts, then the dialer opens.
import { CareProfileRecord } from "@health/contracts/care-profile";
import { Button } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { Phone } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { type ApiState, familyPath, useApi } from "@/lib/api";
import {
	type Contacts,
	dial,
	isFullPhoneNumber,
	shareContactPhone,
	useContacts,
} from "@/lib/contacts";

/** The first care-profile contact with a dialable number, in contact order (#26). */
export const profilePhone = (profile: ApiState<CareProfileRecord>) =>
	profile.kind === "ready"
		? (profile.value.profile.contacts?.find(
				(contact) => contact.phone !== null && isFullPhoneNumber(contact.phone),
			)?.phone ?? null)
		: null;

/**
 * The care profile read for `familyId`, and `call`: saves `phone` on this device as `key`, adds it
 * to the care profile as contact `name`, and opens the dialer. `note` says when the number stays on
 * this phone only.
 */
export function useSaveAndCall(
	familyId: string | null,
	key: "momPhone" | "familyPhone",
	name: string,
) {
	const [contacts, saveContacts] = useContacts();
	const path = familyId === null ? null : familyPath(familyId, "/care-profile");
	const profile = useApi(CareProfileRecord, path);
	const [note, setNote] = useState<string | null>(null);
	const call = (phone: string) => {
		saveContacts({ ...contacts, [key]: phone } satisfies Contacts);
		void shareContactPhone(path, profile, phone, name).then(setNote);
		dial(phone);
	};
	return { contacts, profile, note, call };
}

/** The number field and Save & Call. `onCall` gets only a full number; a short one shows why. */
export function SaveAndCall({
	label,
	big = false,
	icon = <Phone aria-hidden />,
	onCall,
}: {
	label: string;
	/** The wearer's large type and buttons. */
	big?: boolean;
	icon?: ReactNode;
	onCall: (phone: string) => void;
}) {
	const errorId = useId();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const phone = draft.trim();
		if (!isFullPhoneNumber(phone))
			return setError("Enter the full phone number, with the area code.");
		setError(null);
		onCall(phone);
	};
	return (
		<form
			className={big ? "grid gap-2" : "flex flex-wrap items-end gap-2"}
			noValidate
			onSubmit={submit}
		>
			<label
				className={
					big
						? "grid gap-1 font-bold text-[18px]"
						: "grid min-w-0 flex-1 gap-1 text-sm"
				}
			>
				{label}
				<input
					aria-describedby={error === null ? undefined : errorId}
					aria-invalid={error !== null}
					autoComplete="tel"
					className={cn(
						"win95-inset win95-field w-full bg-card px-2",
						big ? "h-12 font-normal text-[20px]" : "h-11",
					)}
					inputMode="tel"
					onChange={(event) => setDraft(event.target.value)}
					type="tel"
					value={draft}
				/>
			</label>
			<Button
				className={
					big
						? "h-16 w-full text-[22px] [&_svg]:size-7"
						: "win95-primary h-11 px-3"
				}
				type="submit"
			>
				{icon} Save & Call
			</Button>
			{error !== null && (
				<p
					className={cn(
						"w-full font-bold text-destructive",
						big ? "text-[16px]" : "text-sm",
					)}
					id={errorId}
				>
					{error}
				</p>
			)}
		</form>
	);
}
