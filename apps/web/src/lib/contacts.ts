// Phone numbers for the "Call Mom", "Call family", and "Call 911" buttons. There is no server
// contract for contact numbers yet, so they are saved on this device only and the screens say so.
// Calls start in the phone's own dialer through `tel:` links; the app never calls or texts by itself.
import { useEffect, useState } from "react";

export type Contacts = {
	readonly momPhone: string | null;
	/** The family member the wearer screen's "Call family" button calls. */
	readonly familyPhone: string | null;
	readonly emergency: string;
	/** `Date.now()` of the last save on this device, or null when never saved. */
	readonly savedAt: number | null;
};

const KEY = "telly.contacts";
const DEFAULT_CONTACTS: Contacts = {
	momPhone: null,
	familyPhone: null,
	emergency: "911",
	savedAt: null,
};

/** A dialable number: an emergency short code (3 digits) or a full number of 7 to 15 digits. */
export const isFullPhoneNumber = (value: string): boolean => {
	if (!/^\+?[0-9()\s.-]+$/.test(value.trim())) return false;
	const digits = value.replace(/\D/g, "").length;
	return digits === 3 || (digits >= 7 && digits <= 15);
};

/** A `tel:` link that keeps only the leading `+` and the digits. */
export const telHref = (value: string): string =>
	`tel:${value.trim().startsWith("+") ? "+" : ""}${value.replace(/\D/g, "")}`;

const phoneOrNull = (stored: object, key: string): string | null => {
	const value: unknown = key in stored ? Reflect.get(stored, key) : null;
	return typeof value === "string" && isFullPhoneNumber(value) ? value : null;
};

const read = (): Contacts => {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
		if (typeof stored !== "object" || stored === null) return DEFAULT_CONTACTS;
		const savedAt = "savedAt" in stored ? stored.savedAt : null;
		return {
			momPhone: phoneOrNull(stored, "momPhone"),
			familyPhone: phoneOrNull(stored, "familyPhone"),
			emergency: phoneOrNull(stored, "emergency") ?? DEFAULT_CONTACTS.emergency,
			savedAt: typeof savedAt === "number" ? savedAt : null,
		};
	} catch {
		return DEFAULT_CONTACTS;
	}
};

const listeners = new Set<() => void>();

/** The saved numbers and a save function. Every screen that uses them updates together. */
export function useContacts(): [Contacts, (next: Contacts) => void] {
	const [contacts, setContacts] = useState<Contacts>(DEFAULT_CONTACTS);
	useEffect(() => {
		const update = () => setContacts(read());
		update();
		listeners.add(update);
		return () => {
			listeners.delete(update);
		};
	}, []);
	const save = (next: Contacts) => {
		localStorage.setItem(KEY, JSON.stringify({ ...next, savedAt: Date.now() }));
		for (const listener of listeners) listener();
	};
	return [contacts, save];
}
