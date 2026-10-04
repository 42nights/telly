// Pure rules for onboarding. No fetches, no React.
import type { HealthSample } from "@health/contracts";

import type { ApiFailure } from "@/lib/api";

/** One line for a failed request. */
export const failureText = (failure: ApiFailure) =>
	failure.kind === "signed_out"
		? "Sign in again to continue."
		: failure.message;

/** Where a signed-in person with this family list must go first, or null to stay. */
export const onboardingTarget = (
	pathname: string,
	familiesEmpty: boolean,
): string | null =>
	familiesEmpty &&
	pathname !== "/welcome" &&
	!pathname.startsWith("/sign-in") &&
	!pathname.startsWith("/join/")
		? "/welcome"
		: null;

/** The invite code from a pasted join link (`…/join/<code>`) or a bare code; null when empty. */
export const inviteCode = (pasted: string): string | null => {
	const text = pasted.trim();
	const code = /\/join\/([^/?#\s]+)/.exec(text)?.[1] ?? text;
	if (code === "" || /[\s/]/.test(code)) return null;
	try {
		return decodeURIComponent(code);
	} catch {
		return null;
	}
};

/** The NOOP link that sets the app's push URL to this family's ingest address. */
export const noopLink = (serverUrl: string, token: string) =>
	`noop://telly-push?url=${encodeURIComponent(
		`${serverUrl}/api/noop/ingest?k=${encodeURIComponent(token)}`,
	)}`;

/** A required whole number from a text field, or null when empty or not a whole number. */
const wholeNumber = (text: string) =>
	/^\d+$/.test(text.trim()) ? Number(text.trim()) : null;

export type ReminderRules = {
	readonly timeZone: string;
	readonly quietHours: null;
	readonly repeatEveryMinutes: number;
	readonly maxPrompts: number;
	readonly snoozeMinutes: number;
};

/** The reminder rules to save from the typed fields, or null while one is missing or not whole. */
export const reminderRules = (
	timeZone: string,
	typed: { repeat: string; max: string; snooze: string },
): ReminderRules | null => {
	const repeatEveryMinutes = wholeNumber(typed.repeat);
	const maxPrompts = wholeNumber(typed.max);
	const snoozeMinutes = wholeNumber(typed.snooze);
	return timeZone !== "" &&
		repeatEveryMinutes !== null &&
		maxPrompts !== null &&
		snoozeMinutes !== null
		? {
				timeZone,
				quietHours: null,
				repeatEveryMinutes,
				maxPrompts,
				snoozeMinutes,
			}
		: null;
};

/** Real WHOOP readings: pushed by NOOP, never synthetic. */
export const whoopSamples = (samples: readonly HealthSample[]) =>
	samples.filter((s) => s.source.startsWith("noop:") && !s.synthetic);

/** The newest heart rate reading by the source's own time, or null. */
export const newestHeartRate = (samples: readonly HealthSample[]) =>
	samples
		.filter((s) => s.metric === "heart_rate")
		.reduce<HealthSample | null>(
			(newest, s) =>
				newest === null ||
				Date.parse(s.sourceTime) > Date.parse(newest.sourceTime)
					? s
					: newest,
			null,
		);

/** `current` is green, `old` is yellow with a grey value, `plain` has no color. */
export type Age = {
	readonly text: string;
	readonly tone: "current" | "old" | "plain";
};

const CURRENT_MINUTES = 10;

/** The age of a live reading (heart rate) from its source time. Older than 10 min is not current. */
export const liveAge = (sourceTime: string, now: number): Age => {
	const minutes = Math.floor((now - Date.parse(sourceTime)) / 60_000);
	if (minutes < 1) return { text: "just now", tone: "current" };
	if (minutes <= CURRENT_MINUTES)
		return { text: `${minutes} min ago`, tone: "current" };
	const text =
		minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
	return { text: `${text} · not current`, tone: "old" };
};

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/**
 * The age of a daily value (sleep, recovery, strain) in local time: "last night" from 18:00
 * yesterday to 06:00 today, "today HH:MM" for the rest of today, otherwise the date.
 */
export const dailyAge = (sourceTime: string, now: number): Age => {
	const at = new Date(sourceTime);
	const today = startOfDay(now);
	const lastNight = new Date(today).setHours(-6);
	const morning = new Date(today).setHours(6);
	if (at.getTime() >= lastNight && at.getTime() < morning)
		return { text: "last night", tone: "plain" };
	if (startOfDay(at.getTime()) === today) {
		const hh = String(at.getHours()).padStart(2, "0");
		const mm = String(at.getMinutes()).padStart(2, "0");
		return { text: `today ${hh}:${mm}`, tone: "plain" };
	}
	return {
		text: at.toLocaleDateString([], { month: "short", day: "numeric" }),
		tone: "plain",
	};
};
