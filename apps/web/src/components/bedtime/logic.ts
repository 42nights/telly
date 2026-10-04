// Overnight lines for the bedtime screen. Each line says what is known and what is not; an unknown
// battery or connection never reads as ready, and only saved reminders (#28) ever wake the wearer.
import type {
	ReminderOccurrence,
	ReminderSettings,
	ReminderState,
} from "@health/contracts/reminders";
import type { SimulatedSpeakerMode } from "@health/contracts/speaker";

/** What the Battery Status API reported, or null when this browser does not report it. */
export type Battery = { readonly level: number; readonly charging: boolean };

export type Line = { readonly ok: boolean; readonly text: string };

export const chargeLine = (battery: Battery | null): Line => {
	if (battery === null)
		return {
			ok: false,
			text: "Charge unknown · this browser does not report the battery. Check that the phone is plugged in.",
		};
	const percent = `${Math.round(battery.level * 100)} %`;
	return battery.charging
		? { ok: true, text: `Charging · ${percent}` }
		: { ok: false, text: `Not charging · ${percent}. Plug in for the night.` };
};

export const connectionLine = (online: boolean, serverLive: boolean): Line => {
	if (!online)
		return { ok: false, text: "No network · this phone is offline." };
	return serverLive
		? { ok: true, text: "Connected to the server." }
		: { ok: false, text: "Network on, but the server does not answer." };
};

/** The home speaker (#46) as an overnight channel. `null` means not loaded: never shown as ready. */
export const speakerLine = (
	enabled: boolean | null,
	mode: SimulatedSpeakerMode | null,
): Line => {
	if (enabled === null)
		return {
			ok: false,
			text: "Home speaker unknown · prompts show on this phone.",
		};
	if (!enabled)
		return {
			ok: false,
			text: "Home speaker off · prompts show on this phone only.",
		};
	return mode === "online"
		? {
				ok: true,
				text: "Home speaker on (simulated, no real speaker yet: issue #46) · it says a due prompt, and this phone shows it.",
			}
		: {
				ok: false,
				text: `Home speaker ${mode ?? "unknown"} · prompts show on this phone.`,
			};
};

/** Sleep-timer choices in minutes; null plays until stopped. */
export const SLEEP_TIMERS = [15, 30, 60, null] as const;

/** "12:05" left on the sleep timer, or null when no timer is set. */
export const timerLeft = (
	endsAt: number | null,
	now: number,
): string | null => {
	if (endsAt === null) return null;
	const seconds = Math.max(0, Math.ceil((endsAt - now) / 1_000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** How far ahead "tonight" reaches from now. */
const NIGHT_MS = 12 * 60 * 60_000;

/** A prompt waits for an answer: due to be shown, or shown and not yet answered. */
export const awaitsAnswer = (o: ReminderOccurrence) =>
	o.promptDue || o.state === "delivered";

const clock = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export type Upcoming = { readonly id: string; readonly text: string };

/**
 * The saved reminders that will prompt in the next 12 hours, soonest first. Only occurrences the
 * database already scheduled count: this screen never adds a prompt of its own.
 */
export const tonight = (
	occurrences: readonly ReminderOccurrence[],
	now: number,
): readonly Upcoming[] =>
	occurrences
		.filter(
			(o) =>
				!awaitsAnswer(o) &&
				o.nextPromptAt !== null &&
				Date.parse(o.nextPromptAt) - now <= NIGHT_MS,
		)
		.sort(
			(a, b) =>
				Date.parse(a.nextPromptAt ?? "") - Date.parse(b.nextPromptAt ?? ""),
		)
		.map((o) => {
			const at = clock(o.nextPromptAt ?? "");
			const held =
				o.state === "scheduled" &&
				Date.parse(o.nextPromptAt ?? "") > Date.parse(o.scheduledFor)
					? ` · set for ${clock(o.scheduledFor)}, held by quiet hours`
					: "";
			return { id: o.id, text: `${at} · ${o.title}${held}` };
		});

/** What happens when nobody answers: the saved routine (#28), never an emergency call. */
export const fallbackText = (settings: ReminderSettings) =>
	`If nobody answers, I ask again every ${settings.repeatEveryMinutes} minutes, up to ${settings.maxPrompts} times. Then your family sees it as unanswered. Nobody calls 911.`;

/** What the wearer's answer recorded. Seen is never done. */
export const ANSWERED: Partial<Record<ReminderState, string>> = {
	acknowledged: "Seen. It is not marked done.",
	self_reported_complete: "Marked done, by you.",
	deferred: "I will ask again later.",
	declined: "Stopped for tonight.",
	unresolved: "Recorded that you need help. This does not call anyone.",
};
