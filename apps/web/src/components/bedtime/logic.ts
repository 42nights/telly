// Overnight readiness lines for the bedtime screen. Each line says what is known and what is not;
// an unknown battery or connection never reads as ready.

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
