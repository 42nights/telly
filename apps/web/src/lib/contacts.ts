// Phone numbers for the "Call Mom", "Call family", and "Call 911" buttons, saved on this device.
// The wearer's "Call my family" first uses the care profile's contacts (#26), which the server keeps.
// Calls start in the phone's own dialer through `tel:` links; the app never calls or texts by itself.
import type { CareProfileRecord } from "@health/contracts/care-profile";
import { useEffect, useState } from "react";

import { type ApiState, apiRequest } from "./api";

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

/** Opens the phone's dialer with `number`, for a call that starts after a form submit, not a link. */
export const dial = (number: string): void => {
	window.location.href = telHref(number);
};

/**
 * Adds `phone` as contact `name` to the care profile at `path`, so every device and the family's
 * agent have it. Resolves to null when kept, else why it stays on this phone only.
 */
export const shareContactPhone = async (
	path: string | null,
	profile: ApiState<CareProfileRecord>,
	phone: string,
	name: string,
): Promise<string | null> => {
	if (path === null || profile.kind !== "ready")
		return `Saved on this phone only. ${
			"message" in profile
				? profile.message
				: "Sign in to share it with your family."
		}`;
	const current = profile.value.profile;
	const result = await apiRequest(null, path, {
		method: "PUT",
		body: {
			...current,
			contacts: [
				...(current.contacts ?? []),
				{ name, relationship: name, phone },
			],
		},
	});
	if (result.kind === "ready") return null;
	return `Saved on this phone only. ${
		result.kind === "signed_out"
			? "Sign in again to share it with your family."
			: result.message
	}`;
};

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
