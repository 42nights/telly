// Pure helpers for the appointment screen: times in the visit's own zone, and the prep form draft.
import type {
	Appointment,
	AppointmentPrep,
} from "@health/contracts/appointments";

/** A UTC instant as the visit's local time, with the zone's short name: "Tue 20 Oct 2026, 10:30 BST". */
export const formatVisitTime = (instant: string | number, timeZone: string) =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone,
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(instant));

// The zone's offset from UTC, in milliseconds, at `utcMillis`.
const zoneOffset = (utcMillis: number, timeZone: string) => {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		})
			.formatToParts(utcMillis)
			.map((part) => [part.type, Number(part.value)]),
	);
	const asUtc = Date.UTC(
		parts.year ?? 0,
		(parts.month ?? 1) - 1,
		parts.day ?? 1,
		parts.hour ?? 0,
		parts.minute ?? 0,
		parts.second ?? 0,
	);
	return asUtc - (utcMillis - (utcMillis % 1000));
};

/**
 * A wall-clock time from `<input type="datetime-local">` (`2026-10-20T10:30`) in `timeZone`, as a
 * UTC instant. The second pass corrects a guess that fell on the other side of a DST change.
 */
export const localToUtc = (local: string, timeZone: string): string => {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
		throw new Error("not a local date and time");
	const naive = Date.parse(`${local}:00Z`);
	if (Number.isNaN(naive)) throw new Error("not a local date and time");
	const first = naive - zoneOffset(naive, timeZone);
	return new Date(naive - zoneOffset(first, timeZone)).toISOString();
};

export const statusLabel: Record<Appointment["status"], string> = {
	suggested: "Suggested · not booked",
	requested: "Requested · simulated, nothing sent · not booked",
	confirmed: "Booked · confirmed by the provider",
	cancelled: "Cancelled",
};

/** The prep form: each list is one entry per line. */
export type PrepDraft = {
	transportation: string;
	reminders: readonly number[];
	symptoms: string;
	medication: string;
	eatingSleep: string;
	questions: string;
};

export const LIST_FIELDS = [
	["symptoms", "Symptoms"],
	["medication", "Medicine questions or doubts"],
	["eatingSleep", "Eating and sleep"],
	["questions", "Questions for the clinician"],
] as const;

export const REMINDER_CHOICES = [
	[1440, "1 day before"],
	[120, "2 hours before"],
	[30, "30 minutes before"],
] as const;

export const emptyPrep: PrepDraft = {
	transportation: "",
	reminders: [1440, 120],
	symptoms: "",
	medication: "",
	eatingSleep: "",
	questions: "",
};

export const draftOf = (prep: AppointmentPrep): PrepDraft => ({
	transportation: prep.transportation ?? "",
	reminders: prep.reminders,
	symptoms: prep.symptoms.join("\n"),
	medication: prep.medication.join("\n"),
	eatingSleep: prep.eatingSleep.join("\n"),
	questions: prep.questions.join("\n"),
});

// One entry per non-blank line, trimmed.
const lines = (text: string) =>
	text.split("\n").flatMap((line) => line.trim() || []);

export const prepOf = (draft: PrepDraft): AppointmentPrep => ({
	transportation: draft.transportation.trim() || null,
	reminders: [...draft.reminders].sort((a, b) => b - a),
	symptoms: lines(draft.symptoms),
	medication: lines(draft.medication),
	eatingSleep: lines(draft.eatingSleep),
	questions: lines(draft.questions),
});
